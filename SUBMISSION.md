# ScamBait: submission kit

## Brief description (paste into the submission form)

ScamBait is an AI decoy that answers scam calls on behalf of vulnerable people. A Gemini-powered elderly persona
("Kamala Aunty" or "Mr. Verma") keeps fraudsters talking in English, Hindi or Hinglish. She stalls, mishears and
asks them to repeat their UPI ID, wasting their time while never revealing anything real. On every turn a second
Gemini agent analyses the caller in parallel using structured JSON output. It produces scam type, risk score,
impersonated organisation, manipulation tactics, red-flag quotes, and every identifier revealed: UPI IDs, mule
accounts, phone numbers and phishing links. When the call ends, Gemini drafts a complaint ready for cybercrime.gov.in
or the 1930 helpline, and the identifiers are added to a shared threat feed.

How we use the Google stack:
- **Gemini** (via the Google Gen AI SDK) powers four agents: the decoy persona, the real-time fraud-intel analyst
  (schema-constrained JSON), a scammer simulator for an AI-vs-AI demo mode, and the complaint writer.
- **Cloud Run** hosts the Node.js/Express backend that orchestrates the agents, running the persona and analyst
  calls in parallel to keep the conversation fast.
- **Firestore** stores call sessions and transcripts, a de-duplicated threat feed of scammer identifiers with
  sighting counts, and global stats (calls handled, scammer minutes wasted, scam-type mix, AI latency).
- **Firebase Hosting** serves the web app and routes `/api/**` to Cloud Run. Firestore security rules lock the
  database to the backend only.

## Demo video script (target 3:30, hard limit 4:00)

**0:00–0:25: Hook.** Screen: a news-style title card, then the ScamBait home screen.
"Every day, scammers posing as police, banks and electricity boards call thousands of people in India. They only
need one person to panic. What if every scam call was answered by someone who never panics, never pays, and never
hangs up? Meet ScamBait."

**0:25–0:45: The idea.** Point at the persona card and the intel panel.
"ScamBait is an AI grandparent. Kamala Aunty keeps the scammer talking. On the right, a second Gemini agent turns
everything the scammer says into evidence, live."

**0:45–2:00: Live AI vs AI call.** Choose *Gemini (AI vs AI demo)* and *Digital arrest*, then press *Answer the call*.
Let three or four turns play with sound on. Narrate briefly over the pauses:
- When the risk bar jumps: "Gemini recognises a digital-arrest scam within one sentence."
- When a UPI ID appears in *Evidence collected*: "Kamala Aunty asked him to spell it again. That's a mule account,
  captured."
- Point at the tactics and red flags: "It explains why this is a scam, in plain language."
- Point at the timer: "Every second on this clock is a second he isn't calling a real victim."

**2:00–2:35: Human mode.** Switch to *Me, speaking* (or typing). A teammate plays a KYC scammer for two turns, ideally in
Hinglish, to show the decoy replies in the same language.

**2:35–3:00: Report.** Press *Hang up and file report*. Show the complaint draft and press *Copy complaint*.
"One click, and the victim, or their family, has a complaint ready for cybercrime.gov.in or the 1930 helpline."

**3:00–3:20: Threat feed.** Open *Threat feed*.
"Every identifier from every call lands in a shared feed on Firestore, de-duplicated and counted, so banks and
users can block them sooner."

**3:20–3:40: Stack and close.** Show the architecture slide.
"Gemini runs four agents, orchestrated on Cloud Run, with Firestore and Firebase Hosting. ScamBait: let the AI
answer the scammers, so they never reach your parents."

Recording tips: use Chrome, turn *Play voices* on, record the browser tab with system audio, and do one dry run first
so Firestore already has a few calls in the threat feed.

## Final checklist

- [ ] Cloud Run deployed with `--min-instances 1`, Firebase Hosting link opens in an incognito window
- [ ] One full AI-vs-AI call works on the deployed link
- [ ] GitHub repo is public, has this README, and contains **no API key**
- [ ] Video is public (YouTube unlisted is fine) and under 4 minutes
- [ ] Deck: team details on slide 1, prototype screenshots on slide 11, measured numbers on slide 12, links on slide 14
- [ ] Deck exported as PDF if the form asks for PDF
