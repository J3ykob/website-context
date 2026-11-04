# What Whisp is (for judges)
Whisp is a chat a small Polish business puts on its website (equipment rental, concrete plant, wedding hall, photographer,
florist, cake shop...). It reads the business's own site and answers that business's customers 24/7: prices from the price
list and simple calculations, what is included, contact, hours, terms; it collects orders/inquiries for the business and
can recommend businesses from a local Warsaw network for things this business does not do. Owners test it on a demo
before buying (panel 149 zł/month); a salesperson shows it to them. Replies are streamed; first_token_s is when the first
word appears, total_s when the reply is complete (checks included).

# Owner's rules for any fix you propose (fixes that break these will be rejected)
- The LLM writes every customer-facing word; code never writes or templates customer replies. Code only gates
  (blocks/regenerates a reply), routes, and computes structure.
- Text -> structure is done by an LLM/classifier, structure -> structure by code, structure -> text by an LLM.
  Code never reads or pattern-matches customer text or page text (no regexes/keyword lists on natural language).
- No brittle special cases (one business, one phrase, one product). Fixes must be general and work for any business.
- Less prompt complexity is better: prefer fixing data, selection, state or checks over adding prompt rules.
- When the business's information does not answer directly but a sentence bears on it: quote that sentence, draw no conclusion.
- Never invent prices, availability, promises; never present another business's offer as the business's own.
