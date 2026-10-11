// Sends a message with an attachment through smtp.js to a fake SMTP server
// that speaks STARTTLS, then takes the received message apart and checks the
// body and the attachment arrived byte for byte.
//
//   node test/smtp.test.js
//
// Needs openssl on the PATH to make a throwaway certificate.

const assert = require("assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const tls = require("tls");
const { sendMail } = require("../smtp.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smtp-test-"));
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-keyout",
    path.join(dir, "key.pem"),
    "-out",
    path.join(dir, "cert.pem"),
  ],
  { stdio: "ignore" },
);
const secureContext = tls.createSecureContext({
  key: fs.readFileSync(path.join(dir, "key.pem")),
  cert: fs.readFileSync(path.join(dir, "cert.pem")),
});
// The certificate is self-signed; this process only ever talks to the fake server.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

function fakeServer(onMessage) {
  return net.createServer((plain) => {
    let socket = plain;
    let inData = false;
    let data = "";
    let buffer = "";
    const reply = (line) => socket.write(line + "\r\n");
    const handle = (chunk) => {
      buffer += chunk;
      if (inData) {
        const end = buffer.indexOf("\r\n.\r\n");
        if (end < 0) return;
        data = buffer.slice(0, end);
        buffer = buffer.slice(end + 5);
        inData = false;
        reply("250 queued");
      }
      let nl;
      while (!inData && (nl = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        if (line.startsWith("EHLO")) reply("250-fake\r\n250 STARTTLS");
        else if (line === "STARTTLS") {
          reply("220 go ahead");
          plain.removeAllListeners("data");
          socket = new tls.TLSSocket(plain, { isServer: true, secureContext });
          socket.setEncoding("utf8");
          socket.on("data", handle);
        } else if (line === "AUTH LOGIN") reply("334 VXNlcm5hbWU6");
        else if (line === Buffer.from("me@example.com").toString("base64")) reply("334 UGFzc3dvcmQ6");
        else if (line === Buffer.from("app-password").toString("base64")) reply("235 ok");
        else if (/^(MAIL FROM|RCPT TO)/.test(line)) reply("250 ok");
        else if (line === "DATA") {
          inData = true;
          reply("354 go");
          return handle("");
        } else if (line === "QUIT") {
          reply("221 bye");
          onMessage(data);
        } else reply("500 unexpected " + line);
      }
    };
    plain.setEncoding("utf8");
    plain.on("data", handle);
    reply("220 fake ready");
  });
}

async function main() {
  const file = Buffer.alloc(200_000).map((_, i) => (i * 7) % 256);
  const b64 = file.toString("base64");
  // Slices whose lengths are multiples of 4 but not of 76, as the CRM serves them.
  async function* chunks() {
    for (let i = 0; i < b64.length; i += 4 * 1000) yield b64.slice(i, i + 4 * 1000);
  }

  let received;
  const server = fakeServer((m) => (received = m));
  await new Promise((r) => server.listen(0, "localhost", r));

  await sendMail(
    {
      host: "localhost",
      port: server.address().port,
      user: "me@example.com",
      pass: "app-password",
      fromName: "Zoë Founder",
    },
    {
      to: "partner@fund.example",
      toName: "Pat Partner",
      cc: "cofounder@example.com",
      subject: "Northwind — seed round",
      body: "Hi Pat,\n\nDeck attached.\n",
      attachments: [{ name: "deck.pdf", mime: "application/pdf", chunks: chunks() }],
    },
  );
  server.close();

  assert.ok(received, "the server received a message");
  const [head, ...parts] = received.split(/\r\n--=_[0-9a-f]+/);
  assert.match(head, /^Subject: =\?UTF-8\?B\?/m, "a non-ASCII subject is encoded");
  assert.match(head, /^Cc: <cofounder@example.com>$/m);
  const body = Buffer.from(parts[0].split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8");
  assert.strictEqual(body, "Hi Pat,\n\nDeck attached.\n");
  const encoded = parts[1].split("\r\n\r\n")[1];
  assert.ok(
    encoded.split("\r\n").every((l) => l.length <= 76),
    "attachment lines are at most 76 chars",
  );
  assert.ok(
    Buffer.from(encoded.replace(/\r\n/g, ""), "base64").equals(file),
    "the attachment arrives intact",
  );
  console.log("smtp: ok");
}

module.exports = { fakeServer };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
