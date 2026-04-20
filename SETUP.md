# Zap Gallery SDK Repository Setup

## Quick Start

The Zap Gallery SDK source is here. To use it:

```bash
# Clone this repo locally
git clone https://github.com/dmcarrington/zap-gallery-sdk.git
cd zap-gallery-sdk

# Install dependencies
npm install

# Build
npm run build

# Use in your project
npm install ../zap-gallery-sdk
```

## Manual Setup (if GitHub isn't accessible)

1. Create a new repository on your Gitea instance
2. Push this SDK to it:

```bash
cd /path/to/zap-gallery-sdk
git remote set-url origin https://your-gitea-instance.com/username/zap-gallery-sdk.git
git push -u origin master
```

3. In your project, install from the local path:

```bash
npm install /path/to/zap-gallery-sdk
```

## Usage in Your Project

```typescript
import { ZapGallerySDK, ZapPaymentSDK, ZapImageSDK } from 'zap-gallery-sdk';

// Initialize
const config = {
	galleryOwnerPubkey: 'your-pubkey-hex',
	relayUrls: ['wss://relay.damus.io', 'wss://relay.nostr.band'],
	blossom: { serverUrls: ['https://blossom.nostr.build'], maxFileSizeMB: 20 }
};

const gallery = new ZapGallerySDK(config);
await gallery.connect();

// Subscribe to images
gallery.subscribe((images) => console.log(images.length, 'images'));

// Verify payment
const payment = new ZapPaymentSDK(gallery.ndk, config.galleryOwnerPubkey);
const result = await payment.verifyPayment({
	slug: 'my-image',
	buyerPubkey: 'buyer-pubkey-hex',
	imageEventId: 'event-id',
	priceSats: 1000
});

if (result.status === 'paid') {
	// Get full-res URL
	const image = new ZapImageSDK(config, 'owner-nsec');
	const url = await image.getFullResUrl('buyer-pubkey-hex', 'my-image', 'event-id', 1000);
	console.log('Full-res URL:', url.url);
}
```

## License

MIT — see [LICENSE](LICENSE) file.
