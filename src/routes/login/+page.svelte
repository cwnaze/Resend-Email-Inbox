<script lang="ts">
	/**
	 * Minimal single-user login flow (US-B04): a centered app mark and a
	 * single "Send me a code" button. No email input field ever appears —
	 * the recipient is a fixed server-side constant (AUTH_RECIPIENT_EMAIL,
	 * see US-B02/FR-1). Clicking the button calls POST
	 * /api/auth/request-code, then the UI transitions in place to a 6-digit
	 * code entry step. Submitting the correct code calls POST
	 * /api/auth/verify-code, which sets the session cookie server-side; on
	 * success we navigate to /inbox.
	 */
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';

	type Step = 'request' | 'code';

	let step = $state<Step>('request');
	let isSubmitting = $state(false);
	let errorMessage = $state<string | null>(null);
	let code = $state('');
	let codeInput = $state<HTMLInputElement | null>(null);
	let showResendNote = $state(false);

	/**
	 * Bumped every time an error is set, and used as a `{#key}` so the
	 * `role="alert"` node is recreated rather than updated. A live region whose
	 * text is byte-identical between two failures is not re-announced, so two
	 * consecutive "Incorrect code." responses would otherwise be announced once.
	 */
	let errorNonce = $state(0);

	function setError(message: string) {
		errorMessage = message;
		errorNonce += 1;
	}

	async function handleRequestCode() {
		if (isSubmitting) return;
		isSubmitting = true;
		errorMessage = null;
		showResendNote = false;

		try {
			const response = await fetch('/api/auth/request-code', { method: 'POST' });

			if (response.status === 429) {
				const body = await response.json().catch(() => ({}));
				const minutes = typeof body.retryAfterMinutes === 'number' ? body.retryAfterMinutes : null;
				setError(
					minutes !== null
						? `Too many code requests. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
						: 'Too many code requests. Please try again later.'
				);
				return;
			}

			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				setError(body.error ?? 'Something went wrong sending the code. Please try again.');
				return;
			}

			step = 'code';
			code = '';
			queueMicrotask(() => codeInput?.focus());
		} catch {
			setError('Network error. Please try again.');
		} finally {
			isSubmitting = false;
		}
	}

	async function handleVerifyCode(event?: SubmitEvent) {
		event?.preventDefault();
		if (isSubmitting || code.length !== 6) return;
		isSubmitting = true;
		errorMessage = null;

		try {
			const response = await fetch('/api/auth/verify-code', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ code })
			});

			// No 429 branch here on purpose: /api/auth/verify-code (US-B03) is not
			// rate-limited — every rejection is a 400. Brute force is bounded by the
			// two limits that do exist: 5 attempts per code and 3 codes per 10
			// minutes, i.e. at most 15 guesses per 10 minutes against a 10^6 space.
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				setError(body.error ?? 'Incorrect code.');
				return;
			}

			await goto(resolve('/inbox'));
		} catch {
			setError('Network error. Please try again.');
		} finally {
			isSubmitting = false;
		}
	}

	function handleCodeInput(event: Event & { currentTarget: HTMLInputElement }) {
		// Strip non-digits at the input rather than relying on `pattern`: the form's
		// onsubmit calls preventDefault() and fetches manually, so native
		// validation never runs. This also normalizes the "123 456" / "123-456"
		// shapes people paste out of an email client.
		code = event.currentTarget.value.replace(/\D/g, '').slice(0, 6);
		// Drop the previous failure as soon as the user starts correcting it —
		// otherwise the UI reads as failing through the whole retype.
		errorMessage = null;

		// Autofill delivers all six digits at once, and typing the sixth digit is
		// an unambiguous "done" — submitting here is what OTP screens do now.
		if (code.length === 6) {
			void handleVerifyCode();
		}
	}

	function handleRequestNewCode() {
		step = 'request';
		code = '';
		errorMessage = null;
		// The code already sent stays valid server-side; requesting another one is
		// what invalidates it and spends one of three requests per 10 minutes. Say
		// so, so this isn't a silent path into a self-inflicted lockout.
		showResendNote = true;
	}
</script>

<svelte:head>
	<title>Log in — dusk</title>
</svelte:head>

<main class="flex min-h-dvh items-center justify-center bg-background p-6 text-text-primary">
	<div class="flex w-full max-w-xs flex-col items-center gap-8">
		<h1 class="font-mono text-lg font-medium tracking-wide">dusk // inbox</h1>

		{#if step === 'request'}
			<div class="flex w-full flex-col items-center gap-3">
				<button
					type="button"
					onclick={handleRequestCode}
					disabled={isSubmitting}
					class="w-full rounded border border-border bg-surface px-4 py-2.5 font-sans text-sm font-medium text-text-primary transition-colors duration-fast ease-standard hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
				>
					{isSubmitting ? 'Sending…' : 'Send me a code'}
				</button>

				{#if showResendNote}
					<p class="w-full text-center font-sans text-xs text-text-muted">
						Any code we already sent stays valid until you request a new one.
					</p>
				{/if}

				{#if errorMessage}
					{#key errorNonce}
						<p role="alert" class="w-full text-center font-sans text-sm text-danger">
							{errorMessage}
						</p>
					{/key}
				{/if}
			</div>
		{:else}
			<form onsubmit={handleVerifyCode} class="flex w-full flex-col items-center gap-3">
				<label for="login-code" class="font-sans text-sm text-text-muted">
					Enter the 6-digit code we sent you
				</label>
				<input
					id="login-code"
					name="code"
					type="text"
					inputmode="numeric"
					autocomplete="one-time-code"
					maxlength="6"
					required
					value={code}
					oninput={handleCodeInput}
					bind:this={codeInput}
					class="w-full rounded border border-border bg-surface px-4 py-2.5 text-center font-mono text-lg tracking-[0.3em] text-text-primary transition-colors duration-fast ease-standard placeholder:text-text-muted focus:border-accent focus:outline-none"
					placeholder="000000"
				/>

				<button
					type="submit"
					disabled={isSubmitting || code.length !== 6}
					class="w-full rounded border border-border bg-surface px-4 py-2.5 font-sans text-sm font-medium text-text-primary transition-colors duration-fast ease-standard hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
				>
					{isSubmitting ? 'Verifying…' : 'Verify code'}
				</button>

				{#if errorMessage}
					{#key errorNonce}
						<p role="alert" class="w-full text-center font-sans text-sm text-danger">
							{errorMessage}
						</p>
					{/key}
				{/if}

				<button
					type="button"
					onclick={handleRequestNewCode}
					class="font-sans text-xs text-text-muted transition-colors duration-fast ease-standard hover:text-accent"
				>
					Request a new code
				</button>
			</form>
		{/if}
	</div>
</main>
