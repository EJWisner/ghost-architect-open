#!/usr/bin/env python3
"""
pulse-optin-test.py
-------------------
Standalone test of the Ghost Open first-run OPT-IN path.

It does NOT touch Ghost's local state, configstore, or firstRun flags.
It simply reproduces, in plain Python, the exact POST that the real
first-run opt-in sends to the signup worker, so you can confirm an
opt-in flows through and the Pulse "Opt-Ins" / "Opt-In Rate" numbers move.

HONESTY GUARDRAILS (deliberate):
  1. Uses a clearly-SYNTHETIC userId ("pulse-optin-test-<timestamp>") so the
     row is unmistakable in Airtable and you can delete it afterward.
  2. DRY-RUN by default: shows you the exact payload and sends nothing.
     You must pass  --send  to actually POST.
  3. Prints the worker's HTTP status + body so you see whether it recorded
     'confirmed'.

Matches the real client (src/telemetry/pulse.js):
  endpoint : https://signup.ghostarchitect.dev/signup
  payload  : { userId, email, version, source, timestamp }
  header   : X-Ghost-Client: ghost-architect-open
"""

import json
import re
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone

SIGNUP_ENDPOINT = "https://signup.ghostarchitect.dev/signup"
# 'cli-firstrun' is the source the worker counts as a real first-run prompt,
# and a valid email makes it record optInStatus='confirmed'. That is what
# moves the Pulse Opt-In Rate. Visible here on purpose so nothing is hidden.
SOURCE = "cli-firstrun"
VERSION = "7.0.0-open"
CLIENT_HEADER = "ghost-architect-open"

# Same shape of email check the worker uses before accepting.
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def main():
    send = "--send" in sys.argv

    print("=" * 60)
    print("  Ghost Open first-run OPT-IN test  (standalone, no Ghost state)")
    print("=" * 60)
    print()
    print("This mimics the email opt-in prompt shown on a first Ghost Open run.")
    print("It posts ONLY to your signup worker. It does not run Ghost or change")
    print("any local Ghost files.")
    print()

    email = input("Enter the email to opt in with: ").strip()

    if not EMAIL_RE.match(email):
        print(f"\n[abort] '{email}' is not a valid email format. The worker would")
        print("        reject this too. Nothing sent.")
        return

    user_id = "pulse-optin-test-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    payload = {
        "userId": user_id,
        "email": email,
        "version": VERSION,
        "source": SOURCE,
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }

    print()
    print("-" * 60)
    print("PAYLOAD that will be POSTed to:", SIGNUP_ENDPOINT)
    print("-" * 60)
    print(json.dumps(payload, indent=2))
    print("Header  X-Ghost-Client:", CLIENT_HEADER)
    print("-" * 60)
    print()

    if not send:
        print("[DRY RUN] Nothing was sent. This was a preview only.")
        print("To actually send the opt-in, re-run with --send :")
        print("    python3 pulse-optin-test.py --send")
        print()
        print("Note: userId is synthetic ('%s')." % user_id)
        print("After testing, you can delete that row from the Airtable")
        print("'signups' table to keep your telemetry clean.")
        return

    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        SIGNUP_ENDPOINT,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
            "X-Ghost-Client": CLIENT_HEADER,
            # Cloudflare's edge returned 1010 to the bare urllib UA. Send a
            # normal UA so the edge treats this like an ordinary client.
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                          "AppleWebKit/537.36 (KHTML, like Gecko) "
                          "Chrome/124.0 Safari/537.36",
            "Accept": "application/json",
        },
    )

    print("[sending...]")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            status = resp.status
            text = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        status = e.code
        text = e.read().decode("utf-8", "replace")
    except Exception as e:
        print(f"[error] request failed: {e}")
        return

    print()
    print("-" * 60)
    print("WORKER RESPONSE")
    print("-" * 60)
    print("HTTP status:", status)
    print("Body:", text)
    print("-" * 60)
    print()
    if '"recorded": "confirmed"' in text or '"recorded":"confirmed"' in text:
        print("[result] Worker recorded this as CONFIRMED.")
        print("         Open Ghost Pulse and refresh: Total Opt-Ins should rise by 1")
        print("         and the userId '%s' should appear." % user_id)
        print("         Delete that synthetic row afterward to keep data clean.")
    else:
        print("[result] Worker did NOT report 'confirmed'. Read the body above for why")
        print("         (e.g. rejected / disposable / no_mx / invalid_format).")


if __name__ == "__main__":
    main()
