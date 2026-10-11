// A small SMTP client: implicit TLS on 465, STARTTLS on 587, AUTH LOGIN.
//
// Hand-written rather than pulled from npm so the mailer installs nothing and
// runs anywhere Node 18 does. The protocol surface used here is a handful of
// commands; the parts worth reading carefully are the MIME layout and the
// attachment streaming at the bottom.

const net = require("net");
const tls = require("tls");
const crypto = require("crypto");

// Wraps a socket in a "send a line, wait for a reply code" interface.
function conversation(socket) {
  let buffer = "";
  let waiting = null;

  // A dropped connection or a timeout fails whatever command is in flight,
  // rather than leaving it waiting forever.
  const fail = (e) => {
    const w = waiting;
    waiting = null;
    if (w) w.reject(e);
  };
  socket.on("error", fail);
  socket.on("timeout", () => {
    fail(new Error("SMTP timed out"));
    socket.destroy();
  });

  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    // A reply is complete when its last line has a space after the code
    // ("250 OK"), as opposed to the "250-" continuation form.
    const lines = buffer.split("\r\n").filter(Boolean);
    if (!/^\d{3} /.test(lines[lines.length - 1] || "")) return;
    const reply = buffer;
    buffer = "";
    const w = waiting;
    waiting = null;
    if (!w) return;
    if (reply.startsWith(String(w.code))) w.resolve(reply);
    else w.reject(new Error(`SMTP ${w.step}: expected ${w.code}, got ${reply.trim().slice(0, 200)}`));
  });

  const expect = (code, step) =>
    new Promise((resolve, reject) => {
      waiting = { code, step, resolve, reject };
    });

  return {
    expect,
    // `step` names the command in errors; it exists so the two credential
    // lines are never quoted into an error message that gets stored.
    send(line, code, step = line) {
      const reply = expect(code, step);
      socket.write(line + "\r\n");
      return reply;
    },
    // Resolves once the data is flushed, so an attachment written in many
    // pieces never piles up in memory, and rejects if the connection dies.
    write: (s) => new Promise((resolve, reject) => socket.write(s, (err) => (err ? reject(err) : resolve()))),
  };
}

async function connect({ host, port }) {
  const timeout = 60_000;
  if (port === 465) {
    const socket = tls.connect({ host, port, servername: host });
    socket.setTimeout(timeout);
    const smtp = conversation(socket);
    await smtp.expect(220, "connect");
    await smtp.send(`EHLO ${host}`, 250);
    return { socket, smtp };
  }

  // Port 587 (or 25): start in plain text, then upgrade before anything
  // sensitive is said.
  const plain = net.connect({ host, port });
  plain.setTimeout(timeout);
  const first = conversation(plain);
  await first.expect(220, "connect");
  await first.send(`EHLO ${host}`, 250);
  await first.send("STARTTLS", 220);
  plain.removeAllListeners("data");
  plain.removeAllListeners("timeout");
  const socket = tls.connect({ socket: plain, servername: host });
  await new Promise((resolve, reject) => socket.once("secureConnect", resolve).once("error", reject));
  socket.setTimeout(timeout);
  const smtp = conversation(socket);
  await smtp.send(`EHLO ${host}`, 250);
  return { socket, smtp };
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const wrap76 = (s) => s.replace(/(.{76})/g, "$1\r\n");
const addressList = (s) =>
  String(s || "")
    .split(/[,;\s]+/)
    .filter(Boolean);

// Headers must be ASCII. A subject or name with anything else goes out as an
// RFC 2047 encoded word, which every mail client decodes.
const headerText = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const mailbox = (name, email) => (name ? `${headerText(name.replace(/"/g, ""))} <${email}>` : `<${email}>`);

// A filename in Content-Type (`name`) or Content-Disposition (`filename`):
// an ASCII fallback, plus the RFC 2231 form when the real name needs it.
function fileParam(key, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return ascii === name
    ? `${key}="${name}"`
    : `${key}="${ascii}"; ${key}*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Send one message.
 *
 * config:  { host, port, user, pass, fromName }
 * message: { to, toName, cc, subject, body, attachments }
 *   attachments: [{ name, mime, chunks }] where `chunks` is an async iterable of
 *   base64 strings that concatenate into the file's base64. The mailer streams
 *   them from the CRM a slice at a time, so a large deck never sits in memory.
 *
 * Pass message = null to log in and hang up (a credentials check).
 */
async function sendMail(config, message) {
  const { socket, smtp } = await connect(config);
  try {
    await smtp.send("AUTH LOGIN", 334);
    await smtp.send(b64(config.user), 334, "AUTH (username)");
    await smtp.send(b64(config.pass), 235, "AUTH (password)");
    if (!message) {
      await smtp.send("QUIT", 221).catch(() => {});
      return null;
    }

    const cc = addressList(message.cc);
    await smtp.send(`MAIL FROM:<${config.user}>`, 250);
    // The envelope decides who receives the message; the Cc header below is
    // only what readers see.
    for (const rcpt of [message.to, ...cc]) await smtp.send(`RCPT TO:<${rcpt}>`, 250);
    await smtp.send("DATA", 354);

    const domain = config.user.split("@")[1] || config.host;
    const messageId = `<${crypto.randomUUID()}@${domain}>`;
    const boundary = `=_${crypto.randomUUID().replace(/-/g, "")}`;
    const attachments = message.attachments || [];

    const headers = [
      `From: ${mailbox(config.fromName, config.user)}`,
      `To: ${mailbox(message.toName, message.to)}`,
      ...(cc.length ? [`Cc: ${cc.map((a) => `<${a}>`).join(", ")}`] : []),
      `Subject: ${headerText(message.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${messageId}`,
      "MIME-Version: 1.0",
    ];
    // The body is base64 too: it keeps UTF-8 intact and sidesteps both line
    // length limits and SMTP's leading-dot escaping.
    const textPart =
      'Content-Type: text/plain; charset="utf-8"\r\n' +
      "Content-Transfer-Encoding: base64\r\n\r\n" +
      wrap76(b64(message.body)) +
      "\r\n";

    if (!attachments.length) {
      await smtp.write(headers.join("\r\n") + "\r\n" + textPart);
    } else {
      headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
      await smtp.write(headers.join("\r\n") + "\r\n\r\n" + `--${boundary}\r\n` + textPart);
      for (const file of attachments) {
        await smtp.write(
          `--${boundary}\r\n` +
            `Content-Type: ${file.mime || "application/octet-stream"}; ${fileParam("name", file.name)}\r\n` +
            `Content-Disposition: attachment; ${fileParam("filename", file.name)}\r\n` +
            "Content-Transfer-Encoding: base64\r\n\r\n",
        );
        // Lines are 76 characters across slice boundaries: whatever does not
        // fill a line carries into the next slice.
        let rest = "";
        for await (const chunk of file.chunks) {
          rest += chunk;
          const cut = rest.length - (rest.length % 76);
          if (cut) await smtp.write(wrap76(rest.slice(0, cut)));
          rest = rest.slice(cut);
        }
        await smtp.write(rest ? rest + "\r\n" : "");
      }
      await smtp.write(`--${boundary}--\r\n`);
    }
    await smtp.send(".", 250, "end of message");
    await smtp.send("QUIT", 221).catch(() => {});
    return messageId;
  } finally {
    socket.destroy();
  }
}

module.exports = { sendMail };
