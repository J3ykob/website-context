#!/bin/bash
# Send campaign emails via Resend and update YALC campaign_leads status
# Usage: ./scripts/send-campaign.sh [--dry-run]

set -euo pipefail

source ~/.gtm-os/.env
CAMPAIGN_ID="662a6fc0-01aa-4032-8963-e3ddb9ec061f"
FROM="Kuba <kuba@flowstock.so>"
EMAILS_FILE="./data/campaigns/warsaw-smb-emails.json"
DB="$HOME/.gtm-os/gtm-os.db"
DRY_RUN="${1:-}"

if [ ! -f "$EMAILS_FILE" ]; then
  echo "Error: $EMAILS_FILE not found"
  exit 1
fi

COUNT=$(python3 -c "import json; print(len(json.load(open('$EMAILS_FILE'))))")
echo "Campaign: Warsaw SMB — Free AI Chatbot Demo"
echo "Emails to send: $COUNT"
echo "From: $FROM"
echo ""

if [ "$DRY_RUN" = "--dry-run" ]; then
  echo "=== DRY RUN — no emails will be sent ==="
  echo ""
fi

export RESEND_API_KEY CAMPAIGN_ID FROM DB EMAILS_FILE
DRY_RUN="${1:-}"
export DRY_RUN

python3 << 'PYTHON'
import json, os, time, sqlite3

dry_run = os.environ.get("DRY_RUN", "") == "--dry-run"
resend_key = os.environ["RESEND_API_KEY"]
campaign_id = os.environ["CAMPAIGN_ID"]
from_addr = os.environ["FROM"]
db_path = os.environ["DB"]

with open(os.environ["EMAILS_FILE"]) as f:
    emails = json.load(f)

sent = 0
failed = 0

for email in emails:
    lead_id = email["id"]
    to = email["to"]
    subject = email["subject"]
    body_text = email["body"]
    body_html = body_text.replace("\n", "<br>")

    print(f"→ {email['company']} ({to})")

    if dry_run:
        print(f"  [DRY RUN] Would send: {subject}")
        sent += 1
        continue

    import urllib.request
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=json.dumps({
            "from": from_addr,
            "to": [to],
            "subject": subject,
            "html": body_html,
        }).encode(),
        headers={
            "Authorization": f"Bearer {resend_key}",
            "Content-Type": "application/json",
        },
    )

    try:
        resp = urllib.request.urlopen(req)
        result = json.loads(resp.read())
        msg_id = result.get("id", "unknown")
        print(f"  ✓ Sent (message_id: {msg_id})")

        # Update YALC campaign_leads status
        conn = sqlite3.connect(db_path)
        conn.execute(
            "UPDATE campaign_leads SET email_sent_at = datetime('now'), email_status = 'sent', lifecycle_status = 'Contacted' WHERE id = ?",
            (lead_id,)
        )
        conn.commit()
        conn.close()

        sent += 1
        time.sleep(1)  # Rate limit
    except Exception as e:
        print(f"  ✗ Failed: {e}")
        failed += 1

print(f"\n{'='*40}")
print(f"Sent: {sent}  Failed: {failed}")
PYTHON
