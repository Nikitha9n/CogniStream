# CogniStream 🚀

CogniStream is a full-stack, AI-powered conversational web application built with Node.js, Express, and the Groq SDK. It provides low-latency token streaming, multi-turn session persistence, and complete chat history management.

🔗 **Live Demo:** [https://cognistream-d4i8.onrender.com/user/login](https://cognistream-d4i8.onrender.com/user/login)

---

## 🛠️ Tech Stack

- **Backend:** Node.js, Express.js
- **AI Engine:** Groq API (LLM SDK)
- **Database:** TiDB Cloud / MySQL (Connection Pooling, `express-mysql-session`)
- **Frontend:** EJS, CSS3, Modern JavaScript (Fetch API)
- **Security & Validation:** Zod Schema Validation, Express Rate Limit, Session Auth[cite: 2]
- **Deployment:** Render[cite: 2]

---

## 🏗️ Architecture

```text
[ Browser / Client ]
       │
       ▼ (HTTP / Sessions)
[ Express.js Server ] ──────► [ Zod Validation & Rate Limiter ]
       │
       ├───► [ Groq SDK / LLM Engine ] ──► (Token Streaming)
       │
       └───► [ TiDB Cloud / MySQL ] ─────► (Users, Sessions & Chat Logs)
```

✨ Key Features
Real-Time Token Streaming: Delivers chunk-by-chunk AI responses with stop/cancellation controls.

Session-Based Context: Retains conversation state to support natural follow-up queries.

Chat Management: Full CRUD support to search, star/mark important, delete, and export chat transcripts.

Production Guardrails: Configured with API rate limiting (5 req/min) and Zod schema validation.

Connection Pooling: Uses pooled MySQL connections to manage database resources efficiently.

Markdown Rendering: Formats responses into styled typography, tables, and highlighted syntax.
