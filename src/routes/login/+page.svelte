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

	async function handleRequestCode() {
		if (isSubmitting) return;
		isSubmitting = true;
		errorMessage = null;

		try {
			const response = await fetch('/api/auth/request-code', { method: 'POST' });

			if (response.status === 429) {
				const body = await response.json().catch(() => ({}));
				const minutes = typeof body.retryAfterMinutes === 'number' ? body.retryAfterMinutes : null;
				errorMessage =
					minutes !== null
						? `Too many code requests. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
						: 'Too many code requests. Please try again later.';
				return;
			}

			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				errorMessage = body.error ?? 'Something went wrong sending the code. Please try again.';
				return;
			}

			step = 'code';
			code = '';
			queueMicrotask(() => codeInput?.focus());
		} catch {
			errorMessage = 'Network error. Please try again.';
		} finally {
			isSubmitting = false;
		}
	}

	async function handleVerifyCode(event: SubmitEvent) {
		event.preventDefault();
		if (isSubmitting) return;
		isSubmitting = true;
		errorMessage = null;

		try {
			const response = await fetch('/api/auth/verify-code', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ code })
			});

			if (response.status === 429) {
				const body = await response.json().catch(() => ({}));
				const minutes = typeof body.retryAfterMinutes === 'number' ? body.retryAfterMinutes : null;
				errorMessage =
					minutes !== null
						? `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
						: 'Too many attempts. Please try again later.';
				return;
			}

			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				errorMessage = body.error ?? 'Incorrect code.';
				return;
			}

			await goto(resolve('/inbox'));
		} catch {
			errorMessage = 'Network error. Please try again.';
		} finally {
			isSubmitting = false;
		}
	}

	function handleUseDifferentCode() {
		step = 'request';
		code = '';
		errorMessage = null;
	}
</script>

<svelte:head>
	<title>Log in — dusk</title>
</svelte:head>

<main class="flex min-h-dvh items-center justify-center bg-background p-6 text-text-primary">
	<div class="flex w-full max-w-xs flex-col items-center gap-8">
		<span class="font-mono text-lg font-medium tracking-wide">dusk // inbox</span>

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

				{#if errorMessage}
					<p role="alert" class="w-full text-center font-sans text-sm text-danger">
						{errorMessage}
					</p>
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
					pattern={'\\d{6}'}
					maxlength="6"
					required
					bind:value={code}
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
					<p role="alert" class="w-full text-center font-sans text-sm text-danger">
						{errorMessage}
					</p>
				{/if}

				<button
					type="button"
					onclick={handleUseDifferentCode}
					class="font-sans text-xs text-text-muted transition-colors duration-fast ease-standard hover:text-accent"
				>
					Start over
				</button>
			</form>
		{/if}
	</div>
</main>
