# Sending email from your own mailbox

The CRM writes your emails and queues them. A small program, `apps/mailer`,
sends them over SMTP from your own address, so replies land in your inbox and
thread like any other email. Nothing goes through a third-party sending
service.

```
 browser ──queue──▶ CRM (Cloudflare) ◀──poll every 5 min── mailer ──SMTP──▶ your mailbox ──▶ investor
                    outbox + deck                          (GitHub Actions)
```

The CRM never holds your mailbox password. The mailer never holds anything but
a token that can read and mark one company's queue.

## 1. Put your deck in

The deck you upload during onboarding is stored and attached to every email by
default. To change it, open **Outbox** in the sidebar, upload a new file, and
tick **Attach to every email** on it. Files up to 11.25 MB can be attached,
which keeps them under Gmail's 25 MB limit once email encoding adds a third.

## 2. Get an app password for your mailbox

The mailer logs in with an **app password**: a separate password your mail
provider issues for one program, which you can revoke without changing your
real one. Most providers require two-step verification before they will issue
one.

| Provider | `SMTP_HOST` | `SMTP_PORT` | Where to get an app password |
|---|---|---|---|
| Gmail / Google Workspace | `smtp.gmail.com` | `465` | myaccount.google.com/apppasswords |
| iCloud Mail | `smtp.mail.me.com` | `587` | account.apple.com, Sign-In and Security, App-Specific Passwords |
| Fastmail | `smtp.fastmail.com` | `465` | Settings, Privacy & Security, Integrations, App passwords |
| Zoho Mail | `smtp.zoho.com` (`.eu`, `.in` by region) | `465` | Account, Security, App Passwords |
| Outlook.com / Microsoft 365 | `smtp.office365.com` | `587` | See the note below |
| Anything else | your provider's SMTP host | `465` or `587` | your provider's docs |

`SMTP_USER` is your full email address. For iCloud, it is your iCloud address,
even if you sign in to Apple with a different one.

**Microsoft.** Microsoft is retiring password sign-in for SMTP. Personal
Outlook.com accounts and many Microsoft 365 tenants already reject it, and the
mailer does not do OAuth. If yours does, the practical route is a provider
from the table, or an alias on your domain sent through one.

**Workspace admins.** Some Google Workspace domains disable app passwords. If
the option is missing, ask your admin, or use a provider that allows them.

## 3. Create a mailer token

In the app, open **Outbox** and click **Create mailer token**. It shows two
lines:

```
CRM_URL=https://your-app.pages.dev
CRM_TOKEN=mt_...
```

Copy them now. The token is shown once and only its hash is stored. Creating a
new one revokes the old one, which is also what to do if it leaks.

## 4. Run the mailer

### On GitHub Actions (recommended)

Your fork already has `.github/workflows/mailer.yml`. It runs every five minutes
and does nothing until the secrets below exist.

In your fork, go to **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|---|---|
| `CRM_URL` | from step 3 |
| `CRM_TOKEN` | from step 3 |
| `SMTP_HOST` | from the table |
| `SMTP_PORT` | from the table |
| `SMTP_USER` | your email address |
| `SMTP_PASS` | the app password from step 2 |
| `MAIL_FROM_NAME` | your name as recipients should see it |

Then open the **Actions** tab. GitHub disables scheduled workflows on new forks
until you enable them there. Run **mailer** once by hand with **Run workflow**
and check the log.

**If your fork is private,** change the schedule. Actions minutes are free and
unlimited on public repositories, but a private one gets 2,000 a month on the
free plan, and GitHub bills every run as at least a minute. Every five minutes
is about 8,600 runs a month. Every 30 minutes (`*/30 * * * *`) is about 1,450.

Two things to know about GitHub's scheduler: runs can start several minutes
late when GitHub is busy, and GitHub pauses scheduled workflows in a repository
that has had no commits for 60 days. If email stops going out after a quiet
spell, re-enable the workflow on the Actions tab.

### Anywhere else

The mailer is one Node 18+ script with no dependencies. On any machine:

```bash
export CRM_URL=... CRM_TOKEN=... SMTP_HOST=... SMTP_PORT=... SMTP_USER=... SMTP_PASS=... MAIL_FROM_NAME=...
node apps/mailer/mailer.js --check     # logs in to SMTP and the CRM, sends nothing
node apps/mailer/mailer.js --dry-run   # prints what is due, sends nothing
node apps/mailer/mailer.js             # sends what is due
```

To run it on a schedule, a crontab line is enough:

```
*/5 * * * * cd /path/to/fundraise-crm && set -a && . ./.env && node apps/mailer/mailer.js >> mailer.log 2>&1
```

Keep that `.env` readable only by you (`chmod 600 .env`). It is gitignored.

## 5. Send something

Open any investor, click **Intro** (or **Create intro**), generate a draft, and
choose **Email it**. Check the address, subject and attachments, then **Queue to
send**. A cold email defaults to the partner's address if their record has one. The bundled list has none, so add it when you add an investor by hand, or type it here. A
warm intro request is addressed to the person you are asking for the
introduction, so you type that address yourself.

The **Outbox** shows each message as queued, sent or failed. A failed message
shows the SMTP server's reason and has a **Retry** button. A sent message is
logged against the investor in **Activity**.

Before your first real send, queue one to yourself.

## When it does not work

| What you see | What it means |
|---|---|
| Outbox says the mailer has never checked in | The workflow is not running: enable it on the Actions tab, or check `CRM_URL` and `CRM_TOKEN`. |
| `bad mailer token` in the workflow log | The token was replaced in the app. Copy the new one into `CRM_TOKEN`. |
| `SMTP AUTH (password): expected 235, got 535` | The mailbox rejected the login. Use an app password, not your normal password, and check `SMTP_USER` is the full address. |
| `SMTP timed out` or `ECONNREFUSED` | Wrong `SMTP_HOST` or `SMTP_PORT`. |
| Sent, but the investor never got it | Check your Sent folder first. If it is there, it left your mailbox, and the rest is the recipient's filtering. Sending from a new domain with no SPF/DKIM records is the usual cause. |

## What the mailer does not do

- **Reply tracking.** Replies arrive in your inbox, not the CRM. Move the deal
  forward by hand when someone answers.
- **HTML email.** Messages go out as plain text, which reads as a person
  writing, not a campaign.
- **Bulk sending.** There is no "send to all" and there will not be one. See
  `data/README.md` on why.
