import os
import smtplib
import logging
from email.message import EmailMessage

logger = logging.getLogger(__name__)

# All SMTP config comes from environment variables — nothing is
# hardcoded here. For Gmail: SMTP_USERNAME is the full gmail address,
# SMTP_PASSWORD must be a 16-character Google "App Password"
# (myaccount.google.com/apppasswords), not the normal account password
# — Gmail rejects plain SMTP auth with the real password.
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USERNAME = os.getenv("SMTP_USERNAME")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD")
SMTP_FROM_EMAIL = os.getenv("SMTP_FROM_EMAIL", SMTP_USERNAME)


class EmailSendError(Exception):
    """Raised when the verification email could not be sent."""
    pass


def send_verification_email(to_email, code):
    """
    Sends a plain-text email containing the 6-digit verification code.
    Raises EmailSendError on any failure — callers decide how to
    surface that (e.g. still return "check your email" to avoid
    leaking whether an address exists, but log the real error).
    """
    if not SMTP_USERNAME or not SMTP_PASSWORD:
        # Fail loudly in logs — a silently-missing SMTP config would
        # otherwise look like "email was sent" to every caller.
        logger.error("SMTP_USERNAME or SMTP_PASSWORD not set in environment")
        raise EmailSendError("Email service is not configured")

    msg = EmailMessage()
    msg["Subject"] = "Your verification code"
    msg["From"] = SMTP_FROM_EMAIL
    msg["To"] = to_email
    msg.set_content(
        f"Your verification code is: {code}\n\n"
        f"This code expires in 10 minutes. If you didn't request this, "
        f"you can safely ignore this email."
    )

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10) as server:
            server.starttls()
            server.login(SMTP_USERNAME, SMTP_PASSWORD)
            server.send_message(msg)
    except smtplib.SMTPException as e:
        logger.error(f"Failed to send verification email to {to_email}: {e}", exc_info=True)
        raise EmailSendError("Could not send verification email") from e

