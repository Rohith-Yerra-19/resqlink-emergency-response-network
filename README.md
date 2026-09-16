# ResQLink — Emergency Disaster Response Network

ResQLink is a full-stack emergency coordination MVP for citizens, verified volunteers, and coordinators. It supports JWT authentication, role-based access, emergency reporting, atomic volunteer acceptance, MongoDB persistence, notifications, and Socket.IO live updates.

## Run locally

1. Copy `server/.env.example` to `server/.env` and set `MONGO_URI` and a strong `JWT_SECRET`.
2. In `server`, run `npm install` then `npm start`.
3. In `client`, run `npm install` then `npm run dev`.

The Vite client uses `http://localhost:5000/api` by default. Set `VITE_API_URL` for deployment. Configure `CLIENT_URL` on the server for production CORS.

## Production notes

Use MongoDB Atlas for `MONGO_URI`, deploy `server` to Render/Railway and `client` to Vercel, and provide environment variables through each platform. HTTPS and an explicit production origin are required before handling real emergency data. The current matching implementation notifies verified/available volunteers; production deployments should add geospatial `$near` filtering, rate limiting, audit logs, and operational monitoring.
"# resqlink-emergency-response-network" 
"# resqlink-emergency-response-network" 
"# resqlink-emergency-response-network" 
"# resqlink-emergency-response-network" 
