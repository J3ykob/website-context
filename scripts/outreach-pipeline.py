#!/usr/bin/env python3
"""
Whisp Outreach Pipeline — scrape first, verify demo, then send email.

Usage:
  python3 scripts/outreach-pipeline.py --input data/leads/prospects.csv [--dry-run]

CSV must have columns: name, domain, email
Optional columns: industry, apollo_org_id

Pipeline for each prospect:
  1. Register as Whisp tenant (skip if exists)
  2. Wait for scraping to complete (with timeout)
  3. Verify demo page works (HTTP 200 + chunks > 0)
  4. Send personalized email via Resend
  5. Log result

Only sends email if demo is confirmed working.
"""

import argparse
import csv
import json
import subprocess
import sys
import time

WHISP_API = "https://whisp.so"
RESEND_KEY = "re_ZS8Wfrja_D6jSS8gGfBmiVbQBAXLXp5mG"
FROM = "Jakub <jakub@whisp.so>"
SCRAPE_TIMEOUT = 300  # 5 min max wait per tenant
SCRAPE_POLL_INTERVAL = 10


def api_call(method, url, data=None, headers=None):
    cmd = ["curl", "-s", "-X", method, url]
    if headers:
        for k, v in headers.items():
            cmd.extend(["-H", f"{k}: {v}"])
    if data:
        cmd.extend(["-H", "Content-Type: application/json", "-d", json.dumps(data)])
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    try:
        return json.loads(r.stdout)
    except:
        return {"error": r.stdout[:100]}


def get_tenant_status(tenant_id):
    return api_call("GET", f"{WHISP_API}/api/tenants/{tenant_id}/status")


def register_tenant(domain, email):
    return api_call("POST", f"{WHISP_API}/api/tenants", {
        "email": email,
        "siteUrl": f"https://{domain}",
    })


def trigger_scrape(tenant_id):
    return api_call("POST", f"{WHISP_API}/api/admin/rescrape/{tenant_id}?maxPages=10")


def wait_for_scrape(tenant_id, timeout=SCRAPE_TIMEOUT):
    start = time.time()
    while time.time() - start < timeout:
        status = get_tenant_status(tenant_id)
        s = status.get("status", "unknown")
        chunks = status.get("chunksCount", 0)
        if s == "active" and chunks > 0:
            return True, chunks
        if s == "error":
            return False, 0
        time.sleep(SCRAPE_POLL_INTERVAL)
    return False, 0


def verify_demo(tenant_id):
    """Check that the demo page returns 200."""
    r = subprocess.run(
        ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", f"{WHISP_API}/demo/{tenant_id}"],
        capture_output=True, text=True, timeout=10,
    )
    return r.stdout.strip() == "200"


def send_email(to, domain, tenant_id, language="en"):
    demo_url = f"https://whisp.so/demo/{tenant_id}"

    if language == "pl":
        subject = f"chatbot dla {domain}"
        body = (
            f"<p>Cześć,</p>"
            f"<p>Zbudowałem chatbota AI, który przeczytał {domain} i potrafi odpowiadać klientom na pytania.</p>"
            f"<p>Dzięki niemu Wasi klienci mogą rozmawiać z Waszą stroną tak jak z chatem GPT "
            f"- zadają pytanie i dostają odpowiedź w kilka sekund.</p>"
            f"<p>Możecie go przetestować: <a href=\"{demo_url}\">{demo_url}</a></p>"
            f"<p>Budujemy portfolio w Polsce - pierwsze 1000 firm dostaje widget bez opłat. "
            f"Żeby go dodać, wystarczy wkleić jedną linijkę kodu na Waszą stronę.</p>"
            f"<p>Więcej o narzędziu: <a href=\"https://whisp.so\">whisp.so</a></p>"
            f"<p>Mogę pomóc z instalacją - zajmie 5 minut.</p>"
            f"<p>Jakub<br>Whisp</p>"
        )
    else:
        subject = f"AI chatbot for {domain}"
        body = (
            f"<p>Hi,</p>"
            f"<p>I built an AI chatbot that read {domain} and can answer your customers' questions instantly.</p>"
            f"<p>Your visitors can chat with your website like ChatGPT "
            f"- they ask a question, get an answer in seconds.</p>"
            f"<p>Try it here: <a href=\"{demo_url}\">{demo_url}</a></p>"
            f"<p>We're building our portfolio - the first 1,000 businesses get the widget at no cost. "
            f"Adding it takes one line of code.</p>"
            f"<p>Learn more: <a href=\"https://whisp.so\">whisp.so</a></p>"
            f"<p>I can help with setup - takes 5 minutes.</p>"
            f"<p>Jakub<br>Whisp</p>"
        )

    result = api_call("POST", "https://api.resend.com/emails", {
        "from": FROM,
        "to": [to],
        "subject": subject,
        "html": body,
        "reply_to": "jakub@whisp.so",
    }, {"Authorization": f"Bearer {RESEND_KEY}"})

    return result.get("id")


def detect_language(domain):
    if domain.endswith(".pl"):
        return "pl"
    return "en"


def main():
    parser = argparse.ArgumentParser(description="Whisp Outreach Pipeline")
    parser.add_argument("--input", required=True, help="CSV file with prospects")
    parser.add_argument("--dry-run", action="store_true", help="Don't send emails")
    parser.add_argument("--skip-existing", action="store_true", default=True, help="Skip already active tenants")
    args = parser.parse_args()

    prospects = []
    with open(args.input) as f:
        for row in csv.DictReader(f):
            if row.get("email"):
                prospects.append(row)

    print(f"Pipeline: {len(prospects)} prospects from {args.input}")
    print(f"{'DRY RUN' if args.dry_run else 'LIVE'}")
    print()

    results = {"registered": 0, "scraped": 0, "verified": 0, "sent": 0, "failed": 0, "skipped": 0}

    for i, p in enumerate(prospects):
        domain = p["domain"]
        email = p["email"]
        tenant_id = domain.replace(".", "_").replace("-", "_")
        lang = detect_language(domain)

        print(f"[{i+1}/{len(prospects)}] {domain}")

        # Step 1: Check if already active
        status = get_tenant_status(tenant_id)
        if status.get("status") == "active" and status.get("chunksCount", 0) > 0:
            if args.skip_existing:
                print(f"  ✓ Already active ({status['chunksCount']} chunks)")
                results["skipped"] += 1

                # Still send email if demo verified
                if verify_demo(tenant_id):
                    if args.dry_run:
                        print(f"  [DRY RUN] Would send to {email}")
                    else:
                        msg_id = send_email(email, domain, tenant_id, lang)
                        if msg_id:
                            print(f"  ✓ Email sent ({msg_id[:8]})")
                            results["sent"] += 1
                        else:
                            print(f"  ✗ Email failed")
                            results["failed"] += 1
                        time.sleep(1)
                continue

        # Step 2: Register tenant
        reg = register_tenant(domain, email)
        if reg.get("tenantId") or "already exists" in str(reg):
            print(f"  ✓ Registered")
            results["registered"] += 1
        else:
            print(f"  ✗ Registration failed: {str(reg)[:60]}")
            results["failed"] += 1
            continue

        # Step 3: Trigger scrape and wait
        trigger_scrape(tenant_id)
        print(f"  ⏳ Scraping...", end="", flush=True)
        ok, chunks = wait_for_scrape(tenant_id)
        if ok:
            print(f" ✓ ({chunks} chunks)")
            results["scraped"] += 1
        else:
            print(f" ✗ Failed/timeout")
            results["failed"] += 1
            continue

        # Step 4: Verify demo
        if verify_demo(tenant_id):
            print(f"  ✓ Demo verified")
            results["verified"] += 1
        else:
            print(f"  ✗ Demo not working")
            results["failed"] += 1
            continue

        # Step 5: Send email
        if args.dry_run:
            print(f"  [DRY RUN] Would send to {email}")
            results["sent"] += 1
        else:
            msg_id = send_email(email, domain, tenant_id, lang)
            if msg_id:
                print(f"  ✓ Email sent ({msg_id[:8]})")
                results["sent"] += 1
            else:
                print(f"  ✗ Email failed")
                results["failed"] += 1
            time.sleep(1)  # rate limit

    print(f"\n{'='*50}")
    print(f"Pipeline Complete")
    print(f"  Registered: {results['registered']}")
    print(f"  Scraped:    {results['scraped']}")
    print(f"  Verified:   {results['verified']}")
    print(f"  Sent:       {results['sent']}")
    print(f"  Skipped:    {results['skipped']}")
    print(f"  Failed:     {results['failed']}")


if __name__ == "__main__":
    main()
