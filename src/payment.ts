/**
 * Payment SDK — verify zap payments against relays or an injected invoice store
 */

import NDK, { type NDKEvent, type NDKSubscription, zapInvoiceFromEvent } from '@nostr-dev-kit/ndk';
import type { DownloadRequest, InvoiceStore, ZapReceipt } from './types';
import { collectEvents } from './gallery';
import { KIND_ZAP_RECEIPT } from './kinds';

const ZAP_FETCH_TIMEOUT_MS = 8000;

/**
 * Payment status enumeration
 */
export enum PaymentStatus {
	PENDING = 'pending',
	PARTIALLY_PAID = 'partially_paid',
	PAID = 'paid',
	EXPIRED = 'expired',
	NOT_FOUND = 'not_found'
}

/**
 * Payment verification result
 */
export interface PaymentResult {
	status: PaymentStatus;
	amountSats: number;
	minRequiredSats: number;
}

export interface ZapPaymentSDKOptions {
	invoiceStore?: InvoiceStore;
	fetchTimeoutMs?: number;
}

/**
 * Main payment SDK class
 */
export class ZapPaymentSDK {
	private ndk: NDK;
	private ownerPubkey: string;
	private invoiceStore?: InvoiceStore;
	private fetchTimeoutMs: number;

	constructor(ndk: NDK, ownerPubkey: string, options: ZapPaymentSDKOptions = {}) {
		this.ndk = ndk;
		this.ownerPubkey = ownerPubkey;
		this.invoiceStore = options.invoiceStore;
		this.fetchTimeoutMs = options.fetchTimeoutMs ?? ZAP_FETCH_TIMEOUT_MS;
	}

	/**
	 * Check if an image has been paid for. Consults the injected invoice
	 * store first (if any) and falls back to zap receipts on relays.
	 */
	async verifyPayment(request: DownloadRequest): Promise<PaymentResult> {
		if (this.invoiceStore) {
			const paid = await this.invoiceStore.hasPaidInvoice(request.slug, request.buyerPubkey);
			if (paid) {
				return {
					status: PaymentStatus.PAID,
					amountSats: request.priceSats,
					minRequiredSats: request.priceSats
				};
			}
		}

		const zapResult = await this.checkZapReceipts(request);
		if (zapResult.status === PaymentStatus.PAID) return zapResult;
		if (zapResult.status === PaymentStatus.PARTIALLY_PAID) return zapResult;

		return {
			status: PaymentStatus.NOT_FOUND,
			amountSats: 0,
			minRequiredSats: request.priceSats
		};
	}

	/**
	 * Query Zap Receipts (kind 9735) from relays and match against the
	 * image, buyer, and gallery owner. Uses NDK's `zapInvoiceFromEvent` so
	 * the amount is taken from the bolt11 invoice rather than from the
	 * zap-request's requested amount.
	 */
	async checkZapReceipts(request: DownloadRequest): Promise<PaymentResult> {
		const receipts = await collectEvents(
			this.ndk,
			{ kinds: [KIND_ZAP_RECEIPT], '#e': [request.imageEventId] },
			this.fetchTimeoutMs
		);

		let maxAmountSats = 0;
		let foundPayment = false;

		for (const receipt of receipts) {
			const invoice = zapInvoiceFromEvent(receipt);
			if (!invoice) continue;

			if (invoice.zappee !== request.buyerPubkey) continue;
			if (invoice.zapped !== this.ownerPubkey) continue;
			if (invoice.zappedEvent && invoice.zappedEvent !== request.imageEventId) continue;

			const amountSats = Math.floor(invoice.amount / 1000);
			maxAmountSats = Math.max(maxAmountSats, amountSats);

			if (amountSats >= request.priceSats) {
				foundPayment = true;
				break;
			}
		}

		if (foundPayment) {
			return {
				status: PaymentStatus.PAID,
				amountSats: maxAmountSats,
				minRequiredSats: request.priceSats
			};
		}

		if (maxAmountSats > 0) {
			return {
				status: PaymentStatus.PARTIALLY_PAID,
				amountSats: maxAmountSats,
				minRequiredSats: request.priceSats
			};
		}

		return {
			status: PaymentStatus.NOT_FOUND,
			amountSats: 0,
			minRequiredSats: request.priceSats
		};
	}

	/**
	 * Subscribe to zap receipts for a specific image event. Invokes
	 * `onReceipt` for every valid receipt (amount authoritative, recipient =
	 * gallery owner). Returns a cleanup function that stops the subscription.
	 */
	subscribeZapReceipts(
		imageEventId: string,
		onReceipt: (receipt: ZapReceipt) => void
	): () => void {
		const sub: NDKSubscription = this.ndk.subscribe(
			{ kinds: [KIND_ZAP_RECEIPT], '#e': [imageEventId] },
			{ closeOnEose: false }
		);

		sub.on('event', (event: NDKEvent) => {
			const receipt = this.extractZapReceipt(event);
			if (!receipt) return;
			if (receipt.recipientPubkey !== this.ownerPubkey) return;
			if (receipt.zappedEventId && receipt.zappedEventId !== imageEventId) return;
			onReceipt(receipt);
		});

		return () => sub.stop();
	}

	/**
	 * Extract a ZapReceipt from a kind 9735 event. Returns null if the
	 * event cannot be parsed into a valid invoice.
	 */
	extractZapReceipt(event: NDKEvent): ZapReceipt | null {
		const invoice = zapInvoiceFromEvent(event);
		if (!invoice) return null;

		return {
			senderPubkey: invoice.zappee,
			recipientPubkey: invoice.zapped,
			amountSats: Math.floor(invoice.amount / 1000),
			zappedEventId: invoice.zappedEvent,
			description: invoice.comment
		};
	}
}
