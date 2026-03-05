# AI Runner — Architecture Diagrams

## 1. VS Code Extension — Internal Flow

```mermaid
flowchart TD
    subgraph VSCode["VS Code Extension"]
        direction TB

        subgraph Panel["Webview Panel (UI)"]
            UI_Current["Current tab\n(live conversations)"]
            UI_History["History tab\n(persisted via globalState)"]
            UI_Log["Log panel\n(worker activity)"]
            UI_Controls["Start / Stop / Settings"]
        end

        subgraph Provider["AiRunnerProvider (TypeScript)"]
            WVP["WebviewProvider\n- manages panel lifecycle\n- watches config changes\n- persists history"]
        end

        subgraph Polling["Poller"]
            W0["Worker 0"]
            W1["Worker 1"]
            W2["Worker 2"]
        end

        subgraph Execution["Executor"]
            EX["executePrompt()\n- calls Copilot LM API\n- streams response\n- supports cancellation"]
            CTS["CancellationTokenSource\nSet (one per active prompt)"]
        end

        subgraph Client["ServerClient"]
            SC["HTTP client\n- GET /api/prompt/wait\n- POST /api/save"]
        end

        Copilot["GitHub Copilot\n(LM API)"]
    end

    UI_Controls -->|start / stop| WVP
    WVP -->|creates / disposes| Polling
    W0 -->|waitForPrompt| SC
    W1 -->|waitForPrompt| SC
    W2 -->|waitForPrompt| SC
    SC -->|long-poll response| W0
    SC -->|long-poll response| W1
    SC -->|long-poll response| W2
    W0 -->|executePrompt| EX
    W1 -->|executePrompt| EX
    W2 -->|executePrompt| EX
    EX -->|sendRequest| Copilot
    Copilot -->|streamed response| EX
    EX -->|response text| W0
    EX -->|response text| W1
    EX -->|response text| W2
    W0 -->|saveResponse| SC
    W1 -->|saveResponse| SC
    W2 -->|saveResponse| SC
    WVP -->|onLog / onStatus| UI_Log
    WVP -->|conversations| UI_Current
    WVP -->|archived entries| UI_History
    UI_Controls -->|cancelAllPrompts| CTS
    CTS -->|cancel token| EX
```

---

## 2. End-to-End System — Server + Extension Interaction

```mermaid
sequenceDiagram
    participant App as Your App<br/>(Postman / Laravel / Python)
    participant Server as AI Runner Server<br/>(Node.js)
    participant Queue as promptQueue<br/>(in-memory FIFO)
    participant Worker as VS Code Worker<br/>(long-poll)
    participant Copilot as GitHub Copilot<br/>(LM API)

    App->>Server: POST /v1/chat/completions<br/>{ model, messages, thread_id }
    Server->>Queue: enqueue prompt + convId

    alt Worker already waiting
        Queue-->>Worker: deliver immediately
    else No worker yet
        Note over Queue,Worker: prompt stays queued<br/>up to 5 min (PROCESSING_TIMEOUT)
        Worker->>Server: GET /api/prompt/wait
        Server-->>Worker: { prompt, id, modelFamily, ... }
    end

    Worker->>Copilot: sendRequest(messages, model)
    Copilot-->>Worker: streamed response

    Worker->>Server: POST /api/save<br/>{ text, promptId, extractJson }

    alt Caller still waiting (< 30s)
        Server-->>App: 200 { choices[0].message.content }
    else Caller timed out (> 30s)
        Server-->>App: 202 { accepted, conversationId, polling_url }
        App->>Server: GET /api/conversations/:id
        Server-->>App: 200 { result: "..." }
    end
```

---

## 3. Parallelism Model

```mermaid
flowchart LR
    subgraph Server
        Q["promptQueue\n[A, B, C, D, E]"]
    end

    subgraph Extension["VS Code Extension (3 workers)"]
        W0["Worker 0<br/>processing A"]
        W1["Worker 1<br/>processing B"]
        W2["Worker 2<br/>processing C"]
        W3["D, E queued<br/>waiting for free worker"]
    end

    Q -->|dequeue| W0
    Q -->|dequeue| W1
    Q -->|dequeue| W2
    Q -.->|waiting| W3

    W0 --> CP0["Copilot<br/>gpt-4.1"]
    W1 --> CP1["Copilot<br/>claude-sonnet-4-5"]
    W2 --> CP2["Copilot<br/>gpt-4o"]
```

---

## 4. Reconnection & Offline Detection

```mermaid
stateDiagram-v2
    [*] --> Idle : Start clicked

    Idle --> Processing : prompt received
    Processing --> Done : response saved
    Done --> Idle : 3s delay

    Processing --> Error : Copilot failed / timeout
    Error --> Idle : 3s delay

    Idle --> Offline : all 3 workers fail to reach server
    Offline --> Idle : any worker reconnects\n(exponential backoff: 3s → 60s)

    Idle --> [*] : Stop clicked
    Processing --> [*] : Stop clicked\n(cancels in-flight requests)
```
