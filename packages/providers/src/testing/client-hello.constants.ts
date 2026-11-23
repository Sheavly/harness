/** Test-only: TLS named group codes, as a ClientHello carries them. */
export const TLS_GROUP = { x25519: 0x001d, x25519Mlkem768: 0x11ec } as const;

/**
 * Test-only: about what one TCP segment carries on a 1,500-byte MTU, less headroom. A ClientHello
 * longer than this is split, and some gateways reset a split one.
 */
export const ONE_TCP_SEGMENT_BYTES = 1400;

/**
 * Test-only: what a ClientHello sent by the model fetch looks like on any OpenSSL, as `helloShape`
 * reads one: it fits in one segment and sends only an X25519 key share. That ML-KEM is still
 * listed holds only where OpenSSL has it (3.5 on), so it is tested apart.
 */
export const MODEL_FETCH_HELLO = { fitsOneSegment: true, keyShares: [TLS_GROUP.x25519] } as const;
