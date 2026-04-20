/**
 * Payment SDK — create invoices, check payment status, verify zaps
 */

import NDK, { type NDKEvent } from '@nostr-dev-kit/ndk';
import { Kind } from 'nostr-tools';
import type { Invoice, DownloadRequest, DownloadResponse, ZapReceipt } from './types';
import { KIND_ZAP_RECEIPT } from './kinds';

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

/**
 * Main payment SDK class
 */
export class ZapPaymentSDK {
	private ndk: NDK;
	private ownerPubkey: string;

	constructor(ndk: NDK, ownerPubkey: string) {
		this.ndk = ndk;
		this.ownerPubkey = ownerPubkey;
	}

	/**
	 * Check if an image has been paid for
	 * Tries multiple verification methods:
	 * 1. Server-side invoice store (fastest)
	 * 2. Zap receipts on relays (fallback)
	 */
	async verifyPayment(request: DownloadRequest): Promise<PaymentResult> {
		// Method 1: Check invoice store (if server-side)
		const invoiceStoreResult = await this.checkInvoiceStore(request);
		if (invoiceStoreResult.status === PaymentStatus.PAID) {
			return invoiceStoreResult;
		}

		// Method 2: Check zap receipts on relays
		const zapResult = await this.checkZapReceipts(request);
		if (zapResult.status === PaymentStatus.PAID) {
			return zapResult;
		}

		if (zapResult.status === PaymentStatus.PARTIALLY_PAID) {
			return zapResult;
		}

		return {
			status: PaymentStatus.NOT_FOUND,
			amountSats: 0,
			minRequiredSats: request.priceSats
		};
	}

	/**
	 * Check server-side invoice store (your app should implement this)
	 */
	protected async checkInvoiceStore(
		request: DownloadRequest
	): Promise<PaymentResult> {
		// This would typically query your database
		// Implementation depends on your backend:
		// - Look up by paymentHash + slug + buyerPubkey
		// - Check if paid=true
		// - Return amount from record
		// This is a stub — override in your implementation
		return {
			status: PaymentStatus.NOT_FOUND,
			amountSats: 0,
			minRequiredSats: request.priceSats
		};
	}

	/**
	 * Query Zap Receipts (kind 9735) from relays
	 */
	async checkZapReceipts(request: DownloadRequest): Promise<PaymentResult> {
		const zapReceipts = await this.ndk.fetchEvents(
			{
				kinds: [KIND_ZAP_RECEIPT],
				'#e': [request.imageEventId]
			},
			undefined,
			8000  // 8s timeout
		);

		let maxAmountSats = 0;
		let foundPayment = false;

		for (const receipt of zapReceipts) {
			const descTag = receipt.tags.find((t) => t[0] === 'description');
			if (!descTag?.[1]) continue;

			try {
				const zapRequest = JSON.parse(descTag[1]);
				const senderPubkey = zapRequest.pubkey;

				// Check if this is from our buyer
				if (senderPubkey !== request.buyerPubkey) continue;

				const amountTag = zapRequest.tags?.find((t: string[]) => t[0] === 'amount');
				const amountMsats = amountTag ? parseInt(amountTag[1], 10) : 0;
				const amountSats = Math.floor(amountMsats / 1000);

				if (amountSats >= request.priceSats) {
					foundPayment = true;
					maxAmountSats = Math.max(maxAmountSats, amountSats);
					break;  // Found a valid payment, stop searching
				}

				maxAmountSats = Math.max(maxAmountSats, amountSats);
			} catch {
				continue;
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
	 * Extract ZapReceipt from a kind 9735 event
	 */
	extractZapReceipt(event: NDKEvent): ZapReceipt | null {
		const descTag = event.tags.find((t) => t[0] === 'description');
		if (!descTag?.[1]) return null;

		try {
			const zapRequest = JSON.parse(descTag[1]);
			const senderPubkey = zapRequest.pubkey;
			const amountTag = zapRequest.tags?.find((t: string[]) => t[0] === 'amount');
			const amountMsats = amountTag ? parseInt(amountTag[1], 10) : 0;

			return {
				senderPubkey,
				amountSats: Math.floor(amountMsats / 1000),
				description: descTag[1]
			};
		} catch {
			return null;
		}
	}
}
