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

    Note over A,B: Room Creation & Key Announcement

    A->>S: Create Room
    S-->>A: Room ID
    A->>S: WebSocket Connect
    S-->>A: welcome (peer_id, is_creator=true)
    A->>S: key_announce (ML-DSA pub + ML-KEM pub + sig)
    Note over A: Generate TreeKEM tree (single leaf)
    Note over A: Derive group key from root secret

    B->>S: WebSocket Connect
    S-->>B: welcome (peer_id, is_creator=false)
    B->>S: key_announce (ML-DSA pub + ML-KEM pub + sig)
    S-->>B: peer_key (Alice's keys)
    S-->>A: peer_joined (Bob's keys)

    Note over A,B: TreeKEM Key Distribution

    Note over A: Verify Bob's ML-DSA sig on ML-KEM pub
    Note over A: Add Bob as leaf in tree
    A->>S: tree_commit (broadcast: new path keys)
    S-->>B: tree_commit
    A->>S: tree_welcome (targeted: tree + encrypted path secrets)
    S-->>B: tree_welcome
    Note over B: Decrypt path secrets via ML-KEM
    Note over B: Derive group key from root secret
    Note over A,B: Both derive identical AES-256-GCM group key

    Note over A,B: Per-message Chain Ratchet

    A->>S: message (AES-GCM ciphertext, epoch, counter)
    S-->>B: message
    Note over B: Ratchet chain → derive message key → decrypt

    B->>S: message (AES-GCM ciphertext, epoch, counter)
    S-->>A: message
    Note over A: Ratchet chain → derive message key → decrypt

    Note over A,B: Periodic Rekey (every 50 messages)

    A->>S: tree_commit (fresh leaf secret, new path keys)
    S-->>B: tree_commit
    Note over A,B: New epoch, new group key, chains re-initialized
```

## License
[MIT](https://opensource.org/license/mit)