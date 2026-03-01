# ReserveWatch Architecture

> Detailed system architecture and data flow diagrams for ReserveWatch

## System Overview

```mermaid
flowchart TB
    subgraph External["External Data Sources"]
        CA[Custodian API A]
        CB[Custodian API B]
    end

    subgraph CRE["Chainlink CRE"]
        WF[ReserveWatch Workflow]
        DON[Decentralized Oracle Network]
    end

    subgraph Onchain["Ethereum Sepolia"]
        RWR[ReserveWatchReceiver]
        LT[LiabilityToken]
    end

    subgraph Console["Operator Console"]
        UI[React Dashboard]
        API[Express API Server]
    end

    CA --> WF
    CB --> WF
    WF --> DON
    DON --> RWR
    RWR --> LT
    API --> RWR
    UI --> API
```

## CRE Workflow Pipeline

```mermaid
flowchart LR
    subgraph Fetch["1. Fetch Reserves"]
        F1[HTTP Capability]
        F2[Fetch Source A]
        F3[Fetch Source B]
        F1 --> F2
        F1 --> F3
    end

    subgraph Compute["2. Compute Coverage"]
        C1[Aggregate Reserves]
        C2[Read Onchain Liabilities]
        C3[Calculate Coverage BPS]
        C1 --> C3
        C2 --> C3
    end

    subgraph Attest["3. Attest Onchain"]
        A1[Build Report Payload]
        A2[Sign Attestation]
        A3[EVM Write Capability]
        A1 --> A2 --> A3
    end

    subgraph Enforce["4. Enforce Policy"]
        E1[ReserveWatchReceiver]
        E2{Coverage >= Threshold?}
        E3[Allow Minting]
        E4[Pause Minting]
        E1 --> E2
        E2 -->|Yes| E3
        E2 -->|No| E4
    end

    Fetch --> Compute --> Attest --> Enforce
```

## Smart Contract Architecture

```mermaid
classDiagram
    class ReserveWatchReceiver {
        +address forwarder
        +address liabilityToken
        +uint256 minCoverageBps
        +uint256 lastReserveUsd
        +uint256 lastCoverageBps
        +bool breakerTripped
        +onReport(bytes metadata, bytes report)
        +getLastAttestation() view
        +isHealthy() view
    }

    class LiabilityToken {
        +address guardian
        +bool mintingPaused
        +uint256 totalSupply
        +setGuardian(address)
        +pauseMinting()
        +resumeMinting()
        +mint(address, uint256)
    }

    class MockForwarder {
        +report(address receiver, bytes report)
    }

    ReserveWatchReceiver --> LiabilityToken : controls minting
    MockForwarder --> ReserveWatchReceiver : delivers reports
```

## Data Flow Sequence

```mermaid
sequenceDiagram
    participant Cron as CRE Cron Trigger
    participant WF as Workflow
    participant API as Custodian APIs
    participant Chain as Sepolia
    participant RWR as ReserveWatchReceiver
    participant LT as LiabilityToken

    Cron->>WF: Trigger (every 60s)
    
    par Fetch Reserves
        WF->>API: GET /reserve/source-a
        API-->>WF: {reserveUsd, signature}
        WF->>API: GET /reserve/source-b
        API-->>WF: {reserveUsd, signature}
    end

    WF->>WF: Verify signatures
    WF->>WF: Aggregate reserves

    WF->>Chain: Read totalSupply (EVM Read)
    Chain-->>WF: liabilities

    WF->>WF: Compute coverage = reserves / liabilities

    WF->>RWR: onReport(metadata, report)
    
    alt Coverage >= minCoverageBps
        RWR->>LT: resumeMinting()
        RWR-->>WF: Healthy attestation stored
    else Coverage < minCoverageBps
        RWR->>LT: pauseMinting()
        RWR-->>WF: Circuit breaker tripped
    end
```

## Console Architecture

```mermaid
flowchart TB
    subgraph Frontend["React Frontend"]
        LP[Landing Page]
        DB[Dashboard]
        
        subgraph Tabs["Dashboard Tabs"]
            OV[Overview Tab]
            SR[Sources Tab]
            OC[Onchain Tab]
            HI[History Tab]
            ST[Settings Tab]
        end

        LP --> DB
        DB --> Tabs
    end

    subgraph Backend["Express Server"]
        SRV[Server]
        
        subgraph APIs["API Endpoints"]
            AS[/api/status]
            AH[/api/history]
            AP[/api/projects]
        end

        subgraph Admin["Admin Endpoints"]
            AM[/admin/mode]
            AI[/admin/incident]
        end

        SRV --> APIs
        SRV --> Admin
    end

    subgraph Data["Data Sources"]
        PJ[projects.json]
        BC[Blockchain RPC]
    end

    Frontend --> Backend
    Backend --> Data
```

## Attestation Report Format

```mermaid
flowchart LR
    subgraph Report["Attestation Report (v2)"]
        direction TB
        R1[reserveUsd: uint256]
        R2[navUsd: uint256]
        R3[coverageBps: uint256]
        R4[timestamp: uint256]
        R5[breakerTripped: bool]
    end

    subgraph Metadata["Report Metadata"]
        direction TB
        M1[version: string]
        M2[projectId: string]
        M3[sources: string array]
    end

    Report --> Encoding
    Metadata --> Encoding
    Encoding[ABI Encode] --> Onchain[Write to Receiver]
```

## Deployment Architecture

```mermaid
flowchart TB
    subgraph Dev["Development"]
        D1[Local Server :8787]
        D2[Vite Dev Server :5173]
        D3[Mock Reserve APIs]
    end

    subgraph Staging["Staging / Demo"]
        S1[Express + Static Build]
        S2[Sepolia Testnet]
        S3[CRE Simulation Mode]
    end

    subgraph Prod["Production Ready"]
        P1[CRE DON Deployment]
        P2[Mainnet Contracts]
        P3[Real Custodian APIs]
    end

    Dev --> Staging --> Prod
```

## Why Chainlink CRE?

```mermaid
mindmap
    root((ReserveWatch + CRE))
        Decentralization
            Multiple DON nodes
            BFT consensus
            No single point of failure
        Capabilities
            HTTP for offchain data
            EVM Read for liabilities
            EVM Write for attestations
        Orchestration
            Cron triggers
            Multi-step workflows
            Conditional logic
        Security
            Cryptographic verification
            Tamper-proof reports
            Institutional grade
```

---

Built for **Chainlink CRE Hackathon 2026**
