<!--
	Placeholder thread view. Exists so US-F01's list rows have a real
	destination to link to (FR-4 of tasks/prd-feature-inbox-list.md); the
	actual thread rendering is US-G01, which replaces this file wholesale.
	The `+page.server.ts` beside it is real as of US-F02 — opening a thread is
	what marks it read.

	Same pattern as the placeholder `/login` page US-A03 stood up ahead of
	the real auth UI.
-->
<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<div class="p-4">
	<h1 class="text-sm font-medium text-text-primary">{data.subject || 'Thread'}</h1>
	<p class="mt-1 font-mono text-xs text-text-muted">
		{data.threadId}
	</p>
	<p class="mt-3 text-sm text-text-muted">The full thread view lands in a later story (US-G01).</p>
</div>
