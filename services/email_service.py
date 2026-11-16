import os
import html
import logging
import requests

logger = logging.getLogger(__name__)

# Config comes from environment variables (.env) — nothing is
# hardcoded here. RESEND_FROM_EMAIL must be an address on a domain you
# have verified in the Resend dashboard (e.g. "no-reply@yourdomain.com").
RESEND_API_KEY = os.getenv("RESEND_API_KEY")
RESEND_FROM_EMAIL = os.getenv("RESEND_FROM_EMAIL")
RESEND_API_URL = "https://api.resend.com/emails"

# Public base URL of the site, e.g. "https://yourdomain.com" (no trailing
# slash needed). Used to build the password-reset link. Deliberately
# read from the environment rather than from request.host_url: a
# forged Host header must never be able to decide where a reset link
# in an email points (reset-link poisoning).
SITE_URL = os.getenv("SITE_URL", "").rstrip("/")

# tODO(Hasan): no site/brand name exists anywhere in the files I've
# seen — replace this placeholder with your real site name. It shows
# up as the "From" display name and in the email header.
SITE_NAME = os.getenv("SITE_NAME", "YOUR_SITE_NAME")

# Hardcoded (not CSS-variable) hex values pulled directly from
# index.css, because Gmail/Outlook/etc. strip <style>-defined custom
# properties in many rendering contexts — email HTML has to be
# self-contained, inline-styled, and table-based for reliable
# cross-client rendering. Keep these in sync with index.css by hand
# if the palette changes; there is no automated link between the two.
COLOR_SAGE_400 = "#7C9082"
COLOR_SLATE_800 = "#2C3531"
COLOR_SLATE_500 = "#5b655e"
COLOR_CREAM_50 = "#FBF9F5"
COLOR_SAND_200 = "#D8CBB9"


class EmailSendError(Exception):
    """Raised when the verification email could not be sent."""
    pass


def _build_html_body(code):
    """
    Table-based, fully inline-styled HTML for maximum client
    compatibility (Outlook in particular ignores most modern CSS).
    Deliberately plain: no external images/CDN assets (a common spam
    signal and a broken-image risk if a client blocks remote content),
    no tracking pixels, minimal links, one clear call-to-action (the
    code itself). This helps avoid spam *content* triggers, but real
    inbox placement depends on domain authentication (SPF/DKIM/DMARC)
    which lives in DNS, not here — see the note in send_verification_email.
    """
    return f"""\
<!DOCTYPE html>
<html>
<body style="margin:0; padding:0; background-color:{COLOR_CREAM_50}; font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:{COLOR_CREAM_50}; padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:12px; overflow:hidden; border:1px solid {COLOR_SAND_200};">
          <tr>
            <td style="background-color:{COLOR_SAGE_400}; padding:24px 32px;">
              <span style="color:#ffffff; font-size:20px; font-weight:bold; letter-spacing:0.02em;">{SITE_NAME}</span>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 16px 0; color:{COLOR_SLATE_800}; font-size:16px; line-height:1.5;">
                Here's your verification code:
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;">
                <tr>
                  <td style="background-color:{COLOR_CREAM_50}; border:1px solid {COLOR_SAND_200}; border-radius:8px; padding:16px 24px;">
                    <span style="color:{COLOR_SLATE_800}; font-size:32px; font-weight:bold; letter-spacing:0.3em;">{code}</span>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px 0; color:{COLOR_SLATE_500}; font-size:14px; line-height:1.5;">
                This code expires in 10 minutes.
              </p>
              <p style="margin:0; color:{COLOR_SLATE_500}; font-size:14px; line-height:1.5;">
                If you didn't request this, you can safely ignore this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
"""


def _post_to_resend(payload, to_email):
    """
    Shared Resend HTTP call used by every email this module sends.
    Raises EmailSendError on any failure; the real reason (unverified
    domain, bad key, etc.) goes to the log only, never to callers.
    """
    try:
        resp = requests.post(
            RESEND_API_URL,
            json=payload,
            headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
            timeout=10,
        )
        resp.raise_for_status()
    except requests.RequestException as e:
        # Resend returns a JSON body explaining the failure (unverified
        # domain, bad key, etc.) — include it in the log, never in the
        # error raised to callers.
        response = getattr(e, "response", None)
        detail = response.text if response is not None else ""
        logger.error(
            f"Failed to send email to {to_email}: {e} {detail}",
            exc_info=True,
        )
        raise EmailSendError("Could not send email") from e


def send_verification_email(to_email, code):
    """
    Sends the verification code via the Resend HTTP API with both an
    HTML version and a plain-text version. Clients that can render HTML
    show the styled version; everything else falls back to plain text.
    Raises EmailSendError on any failure — callers decide how to
    surface that (e.g. still return "check your email" to avoid
    leaking whether an address exists, but log the real error).

    NOTE ON SPAM PLACEMENT: this function controls email *content*
    only. Actual inbox-vs-spam placement is determined mainly by
    sending-domain authentication (SPF, DKIM, DMARC DNS records) and
    sender reputation — neither of which can be set from application
    code. Verify your sending domain in the Resend dashboard and add
    the DNS records it gives you; without a verified domain, Resend
    only allows its onboarding sender and only to your own account email.
    """
    if not RESEND_API_KEY or not RESEND_FROM_EMAIL:
        # Fail loudly in logs — a silently-missing config would
        # otherwise look like "email was sent" to every caller.
        logger.error("RESEND_API_KEY or RESEND_FROM_EMAIL not set in environment")
        raise EmailSendError("Email service is not configured")

    payload = {
        "from": f"{SITE_NAME} <{RESEND_FROM_EMAIL}>",
        "to": [to_email],
        "subject": "Your verification code",
        "html": _build_html_body(code),
        "text": (
            f"Your verification code is: {code}\n\n"
            f"This code expires in 10 minutes. If you didn't request this, "
            f"you can safely ignore this email."
        ),
    }

    _post_to_resend(payload, to_email)


def _build_reset_html_body(reset_url, expires_minutes):
    """
    Same table-based, inline-styled approach as _build_html_body. One
    clear call-to-action button, plus the raw URL underneath as a
    fallback for clients that mangle buttons.
    """
    safe_url = html.escape(reset_url, quote=True)
    return f"""\
<!DOCTYPE html>
<html>
<body style="margin:0; padding:0; background-color:{COLOR_CREAM_50}; font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:{COLOR_CREAM_50}; padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:12px; overflow:hidden; border:1px solid {COLOR_SAND_200};">
          <tr>
            <td style="background-color:{COLOR_SAGE_400}; padding:24px 32px;">
              <span style="color:#ffffff; font-size:20px; font-weight:bold; letter-spacing:0.02em;">{SITE_NAME}</span>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 20px 0; color:{COLOR_SLATE_800}; font-size:16px; line-height:1.5;">
                We received a request to reset your password. Tap the button below to choose a new one.
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;">
                <tr>
                  <td style="background-color:{COLOR_SLATE_800}; border-radius:8px;">
                    <a href="{safe_url}" style="display:inline-block; padding:14px 28px; color:#ffffff; font-size:15px; font-weight:bold; text-decoration:none;">Reset password</a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px 0; color:{COLOR_SLATE_500}; font-size:14px; line-height:1.5;">
                This link expires in {expires_minutes} minutes and can only be used once.
              </p>
              <p style="margin:0 0 16px 0; color:{COLOR_SLATE_500}; font-size:14px; line-height:1.5;">
                If you didn't request this, you can safely ignore this email — your password won't change.
              </p>
              <p style="margin:0; color:{COLOR_SLATE_500}; font-size:12px; line-height:1.5; word-break:break-all;">
                Button not working? Copy this link into your browser:<br>{safe_url}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
"""


def send_password_reset_email(to_email, token, expires_minutes):
    """
    Emails a password-reset link containing the raw `token`. The link
    is built from the SITE_URL environment variable (see note at the
    top of this module). Raises EmailSendError on any failure,
    including missing configuration.
    """
    if not RESEND_API_KEY or not RESEND_FROM_EMAIL:
        logger.error("RESEND_API_KEY or RESEND_FROM_EMAIL not set in environment")
        raise EmailSendError("Email service is not configured")

    if not SITE_URL:
        logger.error("SITE_URL not set in environment — cannot build password reset link")
        raise EmailSendError("Site URL is not configured")

    reset_url = f"{SITE_URL}/auth/reset-password?token={token}"

    payload = {
        "from": f"{SITE_NAME} <{RESEND_FROM_EMAIL}>",
        "to": [to_email],
        "subject": "Reset your password",
        "html": _build_reset_html_body(reset_url, expires_minutes),
        "text": (
            f"We received a request to reset your password.\n\n"
            f"Open this link to choose a new one:\n{reset_url}\n\n"
            f"This link expires in {expires_minutes} minutes and can only be used once. "
            f"If you didn't request this, you can safely ignore this email."
        ),
    }

    _post_to_resend(payload, to_email)

