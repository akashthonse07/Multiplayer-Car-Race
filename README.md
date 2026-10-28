# Cinematic Racer - Multiplayer 3D Car Racing

## Run
1. Install dependencies:
   pip install -r requirements.txt
2. Start server:
   cd backend
   python -m uvicorn main:app --host 0.0.0.0 --port 8000
3. Open http://localhost:8000 in browser.
4. Register two accounts, search friend by User ID, send/accept request, create room, invite, race.

## Features
- 3D cinematic racing with Three.js (bloom, neon track)
- Multiplayer via WebSocket
- Friend system (search by ID, requests, online presence)
- Race rooms, ready, host start, lap tracking
