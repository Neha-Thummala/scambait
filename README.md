# ScamBait

**An AI grandparent that answers scam calls, keeps fraudsters talking, and turns every call into fraud intelligence.**

Built for the Google Cloud AI Builder Cup, theme: *BFSI: Intelligent Risk, Fraud & Financial Experiences*.

Phone scams like "digital arrest", fake KYC updates and task-job frauds cost Indian families crores every month, and they
work because scammers can call thousands of people cheaply. ScamBait flips the economics: every minute a scammer spends
talking to an AI decoy is a minute they are not talking to a real victim, and everything they reveal (UPI IDs, mule
accounts, phone numbers, phishing links, scripts) is captured as structured evidence and shared in a public threat feed.

## What it does

- **AI decoy persona (Gemini).** Kamala Aunty or Mr. Verma answer the call in English, Hindi or Hinglish. They stall,
  mishear, look for their glasses, and steer the scammer into repeating payment details, all while never revealing
  anything real.
- **Live fraud intelligence (Gemini structured output).** On every turn a second Gemini call analyses the caller's words
  in parallel and returns a typed JSON object: scam type, risk score, impersonated organisation, manipulation tactics,
  red-flag quotes, and every identifier revealed. A deterministic regex layer backs it up so no UPI ID is missed.
- **AI vs AI demo mode.** A third Gemini agent plays the scammer from a scripted scenario, so anyone (including judges)
  can watch a full call with no phone or microphone.
- **Voice in, voice out.** Browser speech recognition hears the scammer; speech synthesis gives the decoy a voice.
- **One-click complaint.** When the call ends, Gemini drafts a complaint ready for cybercrime.gov.in or the 1930 helpline.
- **Shared threat feed (Firestore).** Identifiers from every call are de-duplicated and counted across all users, with
  stats on scam types, scammer time wasted and AI latency.

## Architecture

```
Browser (Firebase Hosting)
  ├─ static UI, Web Speech API (speech-to-text + text-to-speech)
  └─ /api/**  ──rewrite──►  Cloud Run service "scambait" (Node.js + Express)
                              ├─ Gemini (via @google/genai)
                              │    ├─ Decoy persona agent      (conversation)
                              │    ├─ Intel analyst agent      (JSON schema output, runs in parallel)
                              │    ├─ Scammer simulator agent  (demo mode)
                              │    └─ Complaint writer         (end of call)
                              └─ Firestore
                                   ├─ sessions/{id}    transcript, latest intel, report
                                   ├─ indicators/{id}  de-duplicated scammer identifiers + counts
                                   └─ stats/global     calls, seconds wasted, scam types, latency
```

## Run locally

```bash
npm install
cp .env.example .env            # add your Gemini API key from https://aistudio.google.com/apikey
export $(cat .env | xargs)
USE_MEMORY_STORE=1 npm start    # no Firestore needed locally
# open http://localhost:8080 in Chrome
```

## Deploy (about 15 minutes)

Prerequisites: `gcloud` and `firebase` CLIs installed, a Google Cloud project with billing, and a Gemini API key.

```bash
export PROJECT_ID=your-project-id
export REGION=asia-south1
export GEMINI_API_KEY=your-key

gcloud config set project $PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com firestore.googleapis.com

# 1. Firestore (Native mode)
gcloud firestore databases create --location=$REGION

# 2. Let the Cloud Run service account use Firestore
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/datastore.user"

# 3. Cloud Run
gcloud run deploy scambait --source . --region $REGION --allow-unauthenticated \
  --set-env-vars GEMINI_API_KEY=$GEMINI_API_KEY,GEMINI_MODEL=gemini-2.5-flash \
  --min-instances 1

# 4. Firebase Hosting + Firestore rules
firebase login
firebase use --add $PROJECT_ID        # or edit .firebaserc
firebase deploy --only hosting,firestore
```

Your public link is `https://$PROJECT_ID.web.app`. The Cloud Run URL also serves the full app on its own.
`--min-instances 1` avoids cold starts while judges are testing.

**Tip:** if Gemini returns a "model not found" error, set `GEMINI_MODEL` to the current Flash model listed in AI Studio
and redeploy with `gcloud run services update scambait --region $REGION --update-env-vars GEMINI_MODEL=...`.

## Using it

Open the link in Chrome or Edge.
- **Gemini (AI vs AI demo):** pick a scam script and press *Answer the call*. Sit back.
- **Me, speaking:** allow the microphone and play the scammer yourself.
- **Me, typing:** type the scammer's lines.

Press *Hang up and file report* to get the complaint draft, then open *Threat feed*.

## Safety and ethics

The decoy never shares real data and never completes a payment. Firestore is locked to the backend only. The demo
scammer agent produces fictional identifiers. In a production rollout ScamBait would sit behind telecom call forwarding
or a "forward suspicious call" button, and identifiers would be verified before being shared with banks.

## Roadmap

- Real phone-number integration (call forwarding through a telephony provider) and Gemini Live API for full-duplex audio.
- More Indian languages (Tamil, Telugu, Kannada, Bengali, Marathi).
- Bank and NPCI integrations to flag mule UPI IDs in near real time.
- Voice-pattern clustering to link calls from the same scam centre.
