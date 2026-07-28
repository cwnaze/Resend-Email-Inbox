<!--
	Placeholder thread view. Exists so US-F01's list rows have a real
	destination to link to (FR-4 of tasks/prd-feature-inbox-list.md); the
	actual thread rendering is US-G01, which replaces this file wholesale
	and adds the `+page.server.ts` load beside it.

	Same pattern as the placeholder `/login` page US-A03 stood up ahead of
	the real auth UI.
-->
<script lang="ts">
	import { page } from '$app/state';
</script>

<div class="p-4">
	<h1 class="text-sm font-medium text-text-primary">Thread</h1>
	<p class="mt-1 font-mono text-xs text-text-muted">
		{page.params.threadId}
	</p>
	<p class="mt-3 text-sm text-text-muted">The full thread view lands in a later story (US-G01).</p>
</div>
