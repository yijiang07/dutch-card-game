# Dutch

A real-time multiplayer card game. Lowest score wins — play from anywhere in a browser.

## Rules

- Each player starts with 4 face-down cards; a randomly chosen player picks how many (0–4) everyone may privately peek at before play begins.
- On your turn, either **flip** the top card of the draw pile face-up onto the discard pile, or **swap** the face-up discard card into your hand (your old card goes face-up onto the pile).
- Power cards trigger when they land face-up on the discard pile:
  - **Jack** — blind-swap any two cards on the table
  - **Queen** — privately peek at any one card
  - **Ace** — give any player an extra face-down card from the deck
- Scoring: A=1, 2–10 face value, J=11, Q=12, **red K=0**, black K=13.
- At the end of your turn you may **call Dutch** — everyone else gets one last turn, then all cards are revealed. Lowest total wins.

## Run locally

```bash
pip3 install -r requirements.txt
python3 server.py
```

Open http://localhost:8743 — create a room, share the 4-letter code.

## Deploy (Render)

This repo includes a `render.yaml` blueprint. On [render.com](https://render.com):
**New → Blueprint**, connect this repo, deploy. Free tier works
(the instance sleeps after ~15 min idle and takes ~30–60s to wake).

Note: game rooms live in server memory, so a restart or redeploy clears
in-progress games.

## Stack

- **Backend** — Python, aiohttp. Server-authoritative rules engine
  ([game.py](game.py)) + WebSocket room server ([server.py](server.py)).
  Clients only ever receive their own card values.
- **Frontend** — vanilla HTML/CSS/JS ([public/](public/)), no build step.
