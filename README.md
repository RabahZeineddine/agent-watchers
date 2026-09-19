# 🤖 Agent Watchers & Personal AI Hub

> An open-source, extensible platform for multi-agent code reviews, asynchronous PR watching, and automated task-tracker reconciliation (Shortcut, Jira, GitHub Issues).

[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.110+-009688.svg)](https://fastapi.tiangolo.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## 🌟 Key Highlights

- **Multi-Agent Review Pipeline**:
  - **Triage Agent** (lightweight/fast model, e.g., GLM 5.3 Flash, GPT-4o-mini, Ollama) categorizes changes, maps sensitive modules, and prepares execution scope.
  - **Critical Auditor Agent** (high-reasoning model, e.g., Gemini 3.8 Flash, DeepSeek V3.2, Claude 3.5 Sonnet) conducts strict evidence-backed defect audits (`file:line`, reproducible failure scenarios, idempotency, security, zero cosmetic nitpicks).
- **Task Tracker Reconciliation (`Task Sync`)**:
  - Connects to **Shortcut**, **Jira**, or **GitHub Issues**.
  - **Smart Ownership Filter**: Distinguishes *your* PRs from *team* PRs.
  - **AI-Assisted Story Creation**: Synthesizes PR diffs into structured tickets (`🎯 Objective`, `🛠️ Changes`, `🧪 Tests`, `🔗 Links`) with 1-click publishing.
- **Local MCP Integration**:
  - Seamlessly leverages Model Context Protocol (MCP) servers (Slack, GitHub, Grafana, DataGrip).
- **Prompt Studio with SQLite Versioning**:
  - Dynamically rewrites and aligns system prompts with your personal tech lead style and past review history.
- **Manual Publication Gateways**:
  - Reviews and Slack notifications are never posted without your explicit 1-click confirmation or private draft review.

---

## 🏗️ Architecture

```
agent-watchers/
├── core/
│   ├── config_loader.py    # Resolves environment variables (${VAR:-default})
│   ├── llm.py              # Pluggable OpenAI-compatible / Gateway / Local LLM client
│   ├── state_store.py      # SQLite persistence for reviews, runs, initiatives, and prompts
│   ├── task_trackers.py    # Pluggable Task Trackers (Shortcut, Jira, GitHub Issues)
│   ├── task_sync.py        # Bidirectional reconciliation engine
│   ├── prompt_optimizer.py # Self-learning prompt alignment engine
│   ├── slack_mcp.py        # Local Slack MCP bridge
│   └── github_mcp.py       # Local GitHub CLI/MCP bridge
├── watchers/
│   └── pr_reviewer/        # Asynchronous multi-agent PR review watcher
├── static/
│   └── index.html          # Clean, responsive Web UI dashboard
├── app.py                  # FastAPI application entrypoint
├── config.yaml             # Declarative configuration file
└── .env.example            # Environment variables template
```

---

## 🚀 Quickstart

### 1. Prerequisites
- Python 3.10+
- [`uv`](https://docs.astral.sh/uv/) (recommended for instant package resolution)
- Git and GitHub CLI (`gh`)

### 2. Setup

```bash
# Clone the repository
git clone https://github.com/your-username/agent-watchers.git
cd agent-watchers

# Copy and configure environment variables
cp .env.example .env

# Edit .env with your credentials and preferred provider
```

### 3. Running Locally

```bash
# Start Web UI & API Server
uv run python3 app.py
```
Open **`http://localhost:8080`** in your browser.

### 4. Running with Docker

```bash
docker compose up --build
```

---

## ⚙️ Configuration (`config.yaml`)

The platform reads settings with environment variable interpolation (`${VAR:-fallback}`):

```yaml
user:
  github_username: "${GITHUB_USER:-your_user}"
  name: "${USER_NAME:-Tech Lead}"

llm:
  provider: "openai_compatible"
  api_base: "${LLM_API_BASE:-https://api.openai.com/v1}"
  api_key: "${LLM_API_KEY}"
  models:
    fast: "gpt-4o-mini"
    reasoning: "gpt-4o"

task_tracker:
  provider: "shortcut" # or "github_issues" / "jira"
  api_token: "${TASK_TRACKER_TOKEN}"
```

---

## 🤝 Contributing

Contributions are welcome! Feel free to submit issues or pull requests for:
- New Task Tracker adapters (Jira Cloud, Linear, ClickUp).
- New watcher types (Grafana log anomaly watcher, Incident thread watcher).
- Additional LLM provider bridges.

---

## 📄 License

MIT License. See [LICENSE](LICENSE) for details.
