# Mobile App Architecture

This document describes the architecture of the QuickEx mobile app (`app/mobile`),
including the screen navigation flow, component hierarchy, wallet data flow, and
backend integration points.

## Overview

The mobile app is an Expo (React Native) application using Expo Router for
file-based navigation. It talks to the QuickEx backend over HTTP and integrates
with Stellar wallets (Freighter / Lobstr) for signing payment-link transactions.

```mermaid
graph TD
    subgraph Device["Mobile Device"]
        UI["Expo Router Screens"]
        WC["WalletContext"]
        SVC["services/ (api, supabase)"]
        WALLET["Freighter / Lobstr"]
    end

    subgraph Backend["QuickEx Backend"]
        API["REST API"]
        DB["Supabase"]
    end

    UI --> WC
    UI --> SVC
    WC --> WALLET
    SVC --> API
    SVC --> DB
    WALLET -->|signed XDR| API
```

## Screen Flow (Expo Router)

All routes live under `app/` and are file-based. The diagram below shows the
navigation transitions between the main routes.

```mermaid
flowchart LR
    Index["/ (index)"] --> WalletConnect["/wallet-connect"]
    Index --> Home["/home"]
    Home --> Payment["/payment"]
    Home --> Dashboard["/dashboard"]
    Payment --> Dashboard
    Dashboard --> Payment
    Index --> DeepLinkDebug["/deep-link-debug"]
    WalletConnect --> Home
```

| Route | Purpose |
|---|---|
| `/` | Landing / entry point. |
| `/wallet-connect` | Connect a Stellar wallet (Freighter / Lobstr). |
| `/home` | Main home screen with quick actions. |
| `/payment` | Create / pay a payment link. |
| `/dashboard` | Wallet activity and link overview. |
| `/deep-link-debug` | Debug screen for validating deep-link parsing. |

## Component Hierarchy

The three main screens compose shared UI components from `components/`.

```mermaid
graph TD
    Home["Home Screen"]
    Payment["Payment Screen"]
    Dashboard["Dashboard Screen"]

    Home --> Header["Header"]
    Home --> BalanceCard["BalanceCard"]
    Home --> QuickActions["QuickActions"]

    Payment --> Header
    Payment --> AmountInput["AmountInput"]
    Payment --> WalletPicker["WalletPicker"]
    Payment --> ConfirmButton["ConfirmButton"]

    Dashboard --> Header
    Dashboard --> LinkList["LinkList"]
    Dashboard --> ActivityFeed["ActivityFeed"]
```

## Wallet Data Flow

Wallet state is owned by `WalletContext` and consumed by screens via the
`useWallet` hook. The context is the single source of truth for the connected
address and signing capability.

```mermaid
sequenceDiagram
    participant User
    participant Screen as Screen (Home/Payment/Dashboard)
    participant WC as WalletContext
    participant Wallet as Freighter / Lobstr
    participant API as Backend API

    User->>Screen: Tap "Connect Wallet"
    Screen->>WC: connect()
    WC->>Wallet: requestAccess()
    Wallet-->>WC: publicKey
    WC-->>Screen: { address, connected }
    User->>Screen: Submit payment
    Screen->>WC: signTransaction(xdr)
    WC->>Wallet: signTransaction(xdr)
    Wallet-->>WC: signedXdr
    WC-->>Screen: signedXdr
    Screen->>API: POST /payments (signedXdr)
    API-->>Screen: payment result
```

## API Integration Points

| Screen / Service | Backend Endpoint | Notes |
|---|---|---|
| `services/api.ts` | `EXPO_PUBLIC_API_URL` | Base URL for all REST calls. |
| Home | `GET /links` | Recent payment links. |
| Payment | `POST /payments` | Submit a signed payment. |
| Dashboard | `GET /payments` | Wallet activity feed. |
| `services/supabase.ts` | `EXPO_PUBLIC_SUPABASE_URL` | Client-side reads via anon key. |

See `app/mobile/README.md` for the environment variables that configure these
integration points.
