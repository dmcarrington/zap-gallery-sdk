/**
 * Nostr event kind constants for Zap Gallery
 */

// Parameterized replaceable events (30000+ range)
export const KIND_GALLERY_META = 30023;     // Gallery metadata (title, description, owner)
export const KIND_IMAGE_LISTING = 30024;    // Per-image listing (title, price, Blossom URLs)

// Application-specific data (encrypted)
export const KIND_APP_DATA = 30078;         // App-specific data (encrypted AES keys, image URLs)

// Zap payment events
export const KIND_ZAP_RECEIPT = 9735;       // Zap receipt (standard Nostr kind)
export const KIND_SEALED_DM = 14;           // NIP-17 sealed DM (optional, for key delivery)

// Standard Nostr kinds
export const KIND_ENCRYPTED_DM = 4;         // NIP-04 encrypted DM

// Delete event (for removal)
export const KIND_DELETE = 5;               // NIP-09 deletion event
