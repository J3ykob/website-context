# Voice campaign recordings

Drop the recorded pitch here as **`whisp-pitch-pl.mp3`**. Once the app is deployed it is
served publicly at `https://whisp.so/voice/whisp-pitch-pl.mp3`, and the Twilio call plays it
via `/api/voice/twiml`. To use a different file, pass `--audio <filename>` to the runner.

## Format
- **MP3** (8 kHz+; mono is fine) or WAV. Keep it short — ~25–35 seconds.
- Telephony is narrowband, so record clearly and avoid background noise/music.

## Suggested script (Polish, ~30s) — edit, then record in your own voice
Per project rules this is a draft for your approval before it goes out:

> Dzień dobry, z tej strony Jakub z Whisp. Dzwonię, bo zbudowałem dla Państwa firmy chatbota AI,
> który przeczytał Państwa stronę i potrafi od ręki odpowiadać klientom na pytania — działa jak
> ChatGPT, ale o Państwa firmie. Przygotowałem gotowe demo, które mogę Państwu wysłać. Jeśli to
> brzmi ciekawie, proszę oddzwonić na ten numer albo napisać SMS-a — odezwę się z linkiem do dema.
> Gdyby nie byli Państwo zainteresowani, proszę odpisać STOP. Dziękuję i miłego dnia!

The recording **must** identify who is calling and offer the STOP opt-out (the `/api/voice/sms-in`
handler honors STOP/NIE by adding the sender to the do-not-call list).
