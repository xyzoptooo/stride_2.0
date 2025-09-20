# Semester Stride Planner Backend

## Overview
This is the backend service for Semester Stride Planner, providing RESTful APIs for course, assignment, note, activity, and user management, as well as AI-powered planning and payment integration.

---

## Technology Stack
- **Node.js** with **Express.js** for the API server
- **MongoDB** (via Mongoose) for persistent data storage
- **Supabase** for authentication/user management integration
- **dotenv** for environment variable management
- **Docker** for containerization and deployment
- **Mpesa API** for payment integration (Kenya)
- **Groq AI API** for AI-powered study planning and recommendations

---

## System Thinking & Design
- **Separation of Concerns:**
  - Backend is decoupled from frontend, exposing a RESTful API for all data and business logic.
  - Models (User, Assignment, Note, Course, Activity) are defined in `/models/` and represent core entities.
- **12-Factor App Principles:**
  - Configuration via environment variables (`.env`)
  - Stateless, horizontally scalable API server
  - Logs and errors are output to the console for easy aggregation
- **API-First Design:**
  - All features (courses, assignments, notes, analytics, payments, AI) are accessible via documented API endpoints (see `API_DOCS.md`).
- **Extensibility:**
  - New features (e.g., additional analytics, integrations) can be added as new endpoints or services.
- **Security:**
  - Sensitive credentials are never hardcoded; use `.env` and Docker secrets for deployment.
  - CORS is enabled for safe cross-origin requests.

---

## Architecture Diagram (Textual)

```
[Frontend (React)] <----REST----> [Express.js API Server] <----> [MongoDB]
                                              |                
                                              |---> [Supabase Auth]
                                              |---> [Groq AI API]
                                              |---> [Mpesa API]
```

---

## Deployment
- The backend is containerized with Docker for easy deployment to any cloud or on-premise environment.
- See the `Dockerfile` for build instructions and `API_DOCS.md` for endpoint usage.

---

## Documentation
- See `API_DOCS.md` for a full list of API endpoints and usage.

---

For support, email: support@semesterstride.com
