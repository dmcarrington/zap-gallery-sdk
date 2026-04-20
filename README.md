# Zap Gallery SDK

TypeScript SDK for integrating with **Nostr Zap Gallery** — a protocol for monetizing images via Lightning zaps on Nostr.

The SDK exposes three cooperating clients:

| Client | Purpose |
| --- | --- |
| `ZapGallerySDK`  | Browse and subscribe to gallery listings published by a gallery owner |
| `ZapPaymentSDK`  | Verify that a buyer has paid for an image (via invoice store or zap receipts) |
| `ZapImageSDK`    | Resolve the full-resolution (encrypted) image URL after payment, and optionally deliver it via NIP-04 DM |

Typical use cases:

- A **frontend** that lists a creator's paid images and lets users zap to unlock them.
- A **backend** that verifies zap payments and hands back full-resolution URLs.
- A **creator tool** that publishes new paid image listings to Nostr.

---

## Requirements

- Node.js 18+ (ESM, `"type": "module"`)
- TypeScript 5+ (recommended — the SDK ships with type declarations)
- Access to one or more Nostr relays
- A [Blossom](https://github.com/hzrd149/blossom) media server for storing image binaries

Peer runtime dependencies are declared in `package.json`:

- `@nostr-dev-kit/ndk`
- `nostr-tools`
- `blossom-client-sdk`

---

## Installation

```bash
npm install zap-gallery-sdk
```

From a local checkout:

```bash
git clone https://github.com/dmcarrington/zap-gallery-sdk.git
cd zap-gallery-sdk
npm install
npm run build

# in your app:
npm install /path/to/zap-gallery-sdk
```

---

## Quick start

```typescript
import NDK from '@nostr-dev-kit/ndk';
import {
  ZapGallerySDK,
  ZapPaymentSDK,
  ZapImageSDK,
  PaymentStatus,
} from 'zap-gallery-sdk';

const config = {
  galleryOwnerPubkey: '<hex-pubkey-of-creator>',
  relays: ['wss://relay.damus.io', 'wss://relay.nostr.band'],
  blossom: {
    serverUrls: ['https://blossom.nostr.build'],
    maxFileSizeMB: 20,
  },
};

// 1. Browse listings
const gallery = new ZapGallerySDK(config);
await gallery.connect();
const images = await gallery.refreshImages();

// 2. Verify a payment for one image
const ndk = new NDK({ explicitRelayUrls: config.relays });
await ndk.connect();

const payment = new ZapPaymentSDK(ndk, config.galleryOwnerPubkey);
const result = await payment.verifyPayment({
  slug: images[0].slug,
  buyerPubkey: '<hex-pubkey-of-buyer>',
  imageEventId: images[0].eventId,
  priceSats: images[0].priceSats,
});

// 3. If paid, resolve the full-res URL
if (result.status === PaymentStatus.PAID) {
  const img = new ZapImageSDK(config, process.env.OWNER_NSEC);
  await img.connect();
  const { url, mimeType } = await img.getFullResUrl(
    '<hex-pubkey-of-buyer>',
    images[0].slug,
  );
  console.log('Unlocked:', url, mimeType);
}
```

---

## Configuration

All three clients accept a `GalleryConfig`:

```typescript
interface GalleryConfig {
  galleryOwnerPubkey: string;       // hex pubkey of the creator publishing listings
  relays: string[];                 // wss:// relay URLs to read/write events
  blossom: {
    serverUrls: string[];           // Blossom media servers
    maxFileSizeMB: number;
  };
}
```

`ZapImageSDK` additionally accepts an `nsec` (private key) so it can decrypt the full-resolution URL stored in an encrypted `kind:30078` event and optionally DM it to the buyer. **Keep this key server-side.**

### Reusing an existing NDK

Servers that already maintain an NDK connection pool should inject it rather than paying the double-connection cost:

```typescript
import { ZapImageSDK, ZapPaymentSDK } from 'zap-gallery-sdk';

const img = ZapImageSDK.fromNdk({ ndk, signer, ownerPubkey });
const payment = new ZapPaymentSDK(ndk, ownerPubkey);
```

---

## Integration flows

### 1. Listing images in a client app

```typescript
import { ZapGallerySDK, type GalleryImage } from 'zap-gallery-sdk';

const gallery = new ZapGallerySDK(config);
await gallery.connect();

// Realtime subscription
const unsubscribe = gallery.subscribe((images: GalleryImage[]) => {
  render(images); // your UI
});

// Or one-shot fetch (hard 5s timeout — resolves with whatever arrived)
const snapshot = await gallery.refreshImages();

// Helpers
const one = gallery.getImageBySlug('sunset-01');
const cheap = gallery.filterImages({ maxPriceSats: 500 });

// Cleanup
unsubscribe();
await gallery.disconnect();
```

Each `GalleryImage` includes a public `thumbnailUrl` (safe to show) and a `fullResUrl` placeholder that only resolves after payment.

### 2. Verifying a payment (server-side)

Payment verification is designed to be called from a trusted backend so you can serve the decrypted URL only to buyers who have paid.

```typescript
import NDK from '@nostr-dev-kit/ndk';
import { ZapPaymentSDK, PaymentStatus } from 'zap-gallery-sdk';

const ndk = new NDK({ explicitRelayUrls: config.relays });
await ndk.connect();

const payment = new ZapPaymentSDK(ndk, config.galleryOwnerPubkey, {
  invoiceStore: {
    async hasPaidInvoice(slug, buyerPubkey) {
      return db.invoices.isPaid(slug, buyerPubkey);
    },
  },
});

const result = await payment.verifyPayment({
  slug,
  buyerPubkey,
  imageEventId,
  priceSats,
});

switch (result.status) {
  case PaymentStatus.PAID:
    // proceed to deliver URL
    break;
  case PaymentStatus.PARTIALLY_PAID:
    // buyer underpaid — show a top-up prompt
    break;
  case PaymentStatus.NOT_FOUND:
  case PaymentStatus.PENDING:
    // ask buyer to zap
    break;
}
```

`verifyPayment` first consults the optional `invoiceStore` (inject your DB adapter) and falls back to querying `kind:9735` zap receipts. Zap receipts are validated using NDK's `zapInvoiceFromEvent`, which cross-checks the bolt11 invoice amount, and the receipt's `p` tag is required to match the gallery owner.

#### Watching zap receipts in real time

```typescript
const unsubscribe = payment.subscribeZapReceipts(imageEventId, (receipt) => {
  if (receipt.senderPubkey === buyerPubkey && receipt.amountSats >= priceSats) {
    unlock();
  }
});
```

### 3. Delivering the full-resolution URL

```typescript
import { ZapImageSDK } from 'zap-gallery-sdk';

const img = new ZapImageSDK(config, process.env.OWNER_NSEC);
await img.connect();

const { url, mimeType } = await img.getFullResUrl(buyerPubkey, slug);
// Return `url` to the authenticated buyer.
// Optionally, the SDK fires off a NIP-04 DM to the buyer with the same payload.
```

### 4. Publishing a new paid image (creator flow)

```typescript
import { ZapImageSDK } from 'zap-gallery-sdk';

const img = new ZapImageSDK(config, process.env.OWNER_NSEC);
await img.connect();

// Public listing (kind 30024)
const listing = img.createImageEvent(
  'sunset-01',                       // slug (d-tag)
  'Sunset over the estuary',         // title
  'Shot on a cold morning in March', // description
  2100,                              // price in sats
  'https://blossom.example/thumb',   // public thumbnail URL
  'https://blossom.example/full',    // private full-res URL (placeholder)
  'image/jpeg',
);
await listing.sign();
await listing.publish();

// Encrypted URL record (kind 30078) — NIP-04 encrypted to the owner
const urlEvent = await img.createImageUrlEvent('sunset-01', {
  url: 'https://blossom.example/full',
  mimeType: 'image/jpeg',
});
await urlEvent.publish();
```

`ZapImageSDK.getFullResUrl` reads and decrypts the `kind:30078` companion event with `d`-tag `zap-gallery-url:<slug>`.

---

## Recommended architecture

```
┌──────────────┐     thumbnails / metadata    ┌─────────────┐
│   Browser    │ ───────────────────────────► │ Nostr relay │
│  (frontend)  │ ◄───────────────────────────│             │
└──────┬───────┘                              └─────────────┘
       │ zap (Lightning)
       ▼
┌──────────────┐                              ┌─────────────┐
│  Your API    │  verifyPayment + getFullResUrl│ Blossom     │
│  (backend)   │ ────────────────────────────► │ (full-res)  │
└──────────────┘                              └─────────────┘
```

- Put `ZapGallerySDK` in the browser — it only reads public events.
- Put `ZapPaymentSDK` and `ZapImageSDK` behind your API — they need the owner's `nsec` and should control access.

---

## Event kinds used

| Kind    | Purpose                                              |
| ------- | ---------------------------------------------------- |
| `30023` | Gallery metadata                                     |
| `30024` | Per-image listing (title, price, thumbnail, mime)    |
| `30078` | Encrypted app data (stores the full-res URL)         |
| `9735`  | Zap receipt (used for payment verification)          |
| `4`     | NIP-04 DM (optional URL delivery to buyer)           |
| `5`     | NIP-09 deletion                                      |

Exported as named constants from `zap-gallery-sdk` (`KIND_IMAGE_LISTING`, `KIND_ZAP_RECEIPT`, etc.).

---

## Development

```bash
npm install
npm run build      # compile TypeScript to dist/
npm run check      # typecheck without emit
npm run lint
```

## License

MIT — see [LICENSE](LICENSE).
