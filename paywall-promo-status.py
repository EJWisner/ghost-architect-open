#!/usr/bin/env python3
"""
paywall-promo-status.py
-----------------------
Shows the LIVE promo text the signup worker is currently serving from its
/pulse-stats endpoint — both the first-run promo and the paywall promo.

This is a READ-ONLY check. It changes nothing: not your terminal environment,
not Ghost's local state, not the worker. It just asks the deployed worker
"what promo text are you serving right now?" and prints the answer.

Why this exists: the worker is a passive-render setup — the CLI shows whatever
promo string the worker returns. This confirms what v7.0.0 clients are actually
seeing in the field for the paywall promo (paywallPromo) and the first-run
promo (promo).

Endpoint: https://signup.ghostarchitect.dev/pulse-stats
"""

import json
import sys
import urllib.request
import urllib.error

PULSE_STATS_ENDPOINT = "https://signup.ghostarchitect.dev/pulse-stats"

# A normal browser UA — the worker sits behind Cloudflare, which 1010-blocks
# bare clients. (Same lesson learned from the opt-in test.)
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/124.0 Safari/537.36",
    "Accept": "application/json",
}


def main():
    print("=" * 64)
    print("  Live promo status from signup worker  (read-only)")
    print("=" * 64)
    print(f"Asking: {PULSE_STATS_ENDPOINT}")
    print()

    req = urllib.request.Request(PULSE_STATS_ENDPOINT, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            status = resp.status
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        print(f"[error] worker returned HTTP {e.code}")
        print(e.read().decode("utf-8", "replace")[:300])
        sys.exit(1)
    except Exception as e:
        print(f"[error] could not reach worker: {e}")
        sys.exit(1)

    if status != 200:
        print(f"[error] unexpected HTTP {status}")
        print(raw[:300])
        sys.exit(1)

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        print("[error] response was not valid JSON. Raw start:")
        print(raw[:300])
        sys.exit(1)

    latest = data.get("latestVersion", "(not present)")
    promo = data.get("promo", None)
    paywall = data.get("paywallPromo", None)

    print(f"latestVersion served : {latest}")
    print()
    print("-" * 64)
    print("FIRST-RUN PROMO  (field: promo)")
    print("-" * 64)
    print(promo if promo is not None else "(field not present in response)")
    print()
    print("-" * 64)
    print("PAYWALL PROMO  (field: paywallPromo)")
    print("-" * 64)
    if paywall is None:
        print("(field NOT present — the deployed worker is not serving")
        print(" paywallPromo yet. The local src/index.js change adding it")
        print(" may not be deployed via `wrangler deploy`.)")
    else:
        print(paywall)
    print("-" * 64)
    print()

    if paywall is None:
        print("[read] paywallPromo is absent from what the worker serves.")
        print("       That means the constant exists in local code but the")
        print("       running worker hasn't been deployed with it. v7.0.0")
        print("       clients would render nothing for the paywall promo.")
    else:
        print("[read] paywallPromo is LIVE. v7.0.0 clients hitting a paywall")
        print("       render exactly the text shown above.")


if __name__ == "__main__":
    main()
