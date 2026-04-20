/**
 * Types and interfaces for Zap Gallery
 */

/**
 * Gallery image metadata as stored on Nostr relays
 */
export interface GalleryImage {
	slug: string;                 // d-tag — unique identifier
	title: string;                // Image title
	description: string;          // Image description
	priceSats: number;            // Price in satoshis
	thumbnailUrl: string;         // Blossom URL (public)
	fullResUrl: string;           // Blossom URL of full-res (kept secret, delivered via DM after payment)
	mimeType: string;             // MIME type (e.g., 'image/jpeg', 'image/png')
	createdAt: number;            // Unix timestamp
	eventId: string;              // Nostr event ID
}

/**
 * Invoice metadata (store-keeper style)
 */
export interface Invoice {
	paymentHash: string;
	slug: string;
	buyerPubkey: string;
	bolt11: string;
	amountSats: number;
	paid: boolean;
	createdAt: number;
	expiresAt: number;
}

/**
 * Download request payload
 */
export interface DownloadRequest {
	slug: string;
	buyerPubkey: string;
	imageEventId: string;
	priceSats: number;
	paymentHash?: string;  // Optional: use this to check a specific invoice
}

/**
 * Download response — decrypted image URL
 */
export interface DownloadResponse {
	url: string;          // Full-res Blossom URL
	mimeType: string;     // MIME type
}

/**
 * Zap receipt data (from kind 9735)
 */
export interface ZapReceipt {
	senderPubkey: string;
	recipientPubkey: string;
	amountSats: number;
	zappedEventId?: string;
	description?: string;
}

/**
 * Nostr relay configuration
 */
export interface RelayConfig {
	url: string;
	enabled: boolean;
}

/**
 * Blossom configuration
 */
export interface BlossomConfig {
	serverUrls: string[];
	maxFileSizeMB: number;
}

/**
 * Gallery configuration
 */
export interface GalleryConfig {
	galleryOwnerPubkey: string;
	relays: string[];
	blossom: BlossomConfig;
}

/**
 * Pluggable server-side invoice store. Consumers implement this to
 * short-circuit zap-receipt lookups with a trusted record of payment.
 */
export interface InvoiceStore {
	hasPaidInvoice(slug: string, buyerPubkey: string): Promise<boolean>;
}
