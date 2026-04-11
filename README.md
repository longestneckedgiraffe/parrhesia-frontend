# parrhesia-frontend

The frontend code for https://parrhesia.chat/

## About

Parrhesia is a very basic end-to-end encrypted chatting service.

## Security

Parrhesia's key exchange uses ML-KEM-768, signatures use ML-DSA-65, and message encryption uses AES-256-GCM. Group key management utilizes efficient re-keying via TreeKEM. Despite these characteristics making Parrhesia post-quantum-safe, parrhesia.chat is still a use-at-your-own-risk service.

ML-KEM-768 and ML-DSA-65 are documented [here](https://csrc.nist.gov/pubs/fips/204/final) and GCM/GMAC is documented [here](https://csrc.nist.gov/pubs/sp/800/38/d/final). TreeKEM key distribution is covered in [this](https://eprint.iacr.org/2025/229.pdf) paper.

## Mermaid Diagram

```mermaid
sequenceDiagram
    participant A as Alice (Creator)
    participant S as Server
    participant B as Bob (Joiner)

    Note over A,B: Key Exchange

    A->>S: Create Room + WebSocket Connect
    S-->>A: Room ID + welcome
    A->>S: key_announce (ML-KEM pub, ML-DSA pub)

    B->>S: WebSocket Connect
    B->>S: key_announce (ML-KEM pub, ML-DSA pub)
    S-->>A: peer_joined (Bob's keys)
    S-->>B: peer_key (Alice's keys)

    Note over A,B: TreeKEM Group Key Setup

    A->>S: tree_commit + tree_welcome (encrypted path secrets)
    S-->>B: tree_commit + tree_welcome
    Note over A,B: Both derive identical AES-256-GCM group key

    Note over A,B: Encrypted Messaging

    A->>S: message (AES-GCM ciphertext)
    S-->>B: message
    B->>S: message (AES-GCM ciphertext)
    S-->>A: message

    Note over A,B: Rekey every 50 messages via tree_commit
```

## License
[MIT](https://opensource.org/license/mit)