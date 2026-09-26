<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { MAX_IMAGES, processImage } from "../lib/image-attachment";
  import { composerState, promptResult, sendPrompt } from "../lib/ui-bridge";
  import type { BrowserPromptImage } from "../lib/types";
  import Icon from "./Icon.svelte";

  interface Attachment extends BrowserPromptImage {
    id: string;
    previewUrl: string;
  }

  let text = $state("");
  let attachments = $state<Attachment[]>([]);
  let processing = $state(false);
  let error = $state("");
  let fileInput: HTMLInputElement;
  let textarea: HTMLTextAreaElement;
  let previousSelectedId: string | undefined;
  let attachmentEpoch = 0;
  let destroyed = false;
  let pendingCommandId = $state<string>();

  $effect(() => {
    const selectedId = $composerState.selectedId;
    if (previousSelectedId !== undefined && previousSelectedId !== selectedId) {
      attachmentEpoch += 1;
      clearAttachments();
      text = "";
      pendingCommandId = undefined;
      error = "";
    }
    previousSelectedId = selectedId;
  });

  $effect(() => {
    if (!$composerState.supportsImages && attachments.length > 0) {
      attachmentEpoch += 1;
      clearAttachments();
      error = "The selected model does not support images.";
    }
  });

  $effect(() => {
    if (!$composerState.connected && pendingCommandId) {
      pendingCommandId = undefined;
      error = "Connection lost before Pi acknowledged the message. You can retry it.";
    }
  });

  $effect(() => {
    const result = $promptResult;
    if (!result || result.commandId !== pendingCommandId) return;
    pendingCommandId = undefined;
    if (result.ok) {
      text = "";
      clearAttachments();
      error = "";
    } else {
      error = result.error || "Pi did not accept the message. You can retry it.";
    }
  });

  $effect(() => {
    text;
    void tick().then(resizeTextarea);
  });

  onDestroy(() => {
    destroyed = true;
    attachmentEpoch += 1;
    clearAttachments();
  });

  async function chooseFiles(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    if (files.length === 0) return;
    error = "";
    const available = MAX_IMAGES - attachments.length;
    if (available <= 0) {
      error = `You can attach up to ${MAX_IMAGES} images.`;
      return;
    }
    processing = true;
    const epoch = attachmentEpoch;
    const selectedId = $composerState.selectedId;
    try {
      for (const file of files.slice(0, available)) {
        try {
          const image = await processImage(file);
          if (destroyed
            || epoch !== attachmentEpoch
            || selectedId !== $composerState.selectedId
            || !$composerState.supportsImages) return;
          attachments = [...attachments, {
            id: crypto.randomUUID(),
            data: image.data,
            mimeType: image.mimeType,
            previewUrl: URL.createObjectURL(image.blob),
          }];
        } catch (cause) {
          error = cause instanceof Error ? cause.message : "The image could not be processed.";
        }
      }
      if (files.length > available) error = `Only the first ${available} image${available === 1 ? "" : "s"} was added.`;
    } finally {
      processing = false;
    }
  }

  function removeAttachment(id: string): void {
    const attachment = attachments.find((item) => item.id === id);
    if (attachment) URL.revokeObjectURL(attachment.previewUrl);
    attachments = attachments.filter((item) => item.id !== id);
  }

  function clearAttachments(): void {
    for (const attachment of attachments) URL.revokeObjectURL(attachment.previewUrl);
    attachments = [];
  }

  function openImagePicker(): void {
    if (!$composerState.supportsImages) {
      error = "The selected model does not report image support. After updating, run /reload in that Pi terminal.";
      return;
    }
    fileInput?.click();
  }

  function submit(): void {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || processing) return;
    const commandId = sendPrompt({
      ...(trimmed ? { text: trimmed } : {}),
      ...(attachments.length > 0
        ? { images: attachments.map(({ mimeType, data }) => ({ mimeType, data })) }
        : {}),
      behavior: "followUp",
    });
    if (!commandId) return;
    pendingCommandId = commandId;
    error = "";
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  function resizeTextarea(): void {
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }

  const canOpenAttachment = $derived($composerState.connected && !processing && !pendingCommandId && attachments.length < MAX_IMAGES);
  const canSend = $derived(
    $composerState.connected
      && Boolean($composerState.selectedId)
      && !processing
      && !pendingCommandId
      && (text.trim().length > 0 || attachments.length > 0),
  );
</script>

<form id="prompt-form" class="composer composer-rich" onsubmit={(event) => { event.preventDefault(); submit(); }}>
  {#if attachments.length > 0}
    <div class="attachment-strip" aria-label="Attached images">
      {#each attachments as attachment (attachment.id)}
        <div class="attachment-preview">
          <img src={attachment.previewUrl} alt="Attachment preview" />
          <button type="button" aria-label="Remove image" onclick={() => removeAttachment(attachment.id)}>
            <Icon name="close" />
          </button>
        </div>
      {/each}
      <span class="attachment-count">{attachments.length}/{MAX_IMAGES}</span>
    </div>
  {/if}
  <div class="composer-row">
    <input
      class="image-input"
      bind:this={fileInput}
      type="file"
      accept="image/*"
      multiple
      onchange={chooseFiles}
      aria-label="Choose images"
    />
    <button
      type="button"
      class="attach-button"
      disabled={!canOpenAttachment}
      aria-label="Attach images"
      title={$composerState.supportsImages ? `Attach up to ${MAX_IMAGES} images` : "Image input unavailable for this process/model"}
      onclick={openImagePicker}
    >
      <Icon name="image" />
    </button>
    <textarea
      id="prompt"
      bind:this={textarea}
      bind:value={text}
      rows="1"
      placeholder={processing ? "Processing image…" : pendingCommandId ? "Sending…" : "Message Pi…"}
      aria-label="Message Pi"
      disabled={!$composerState.selectedId || Boolean(pendingCommandId)}
      onkeydown={keydown}
    ></textarea>
    <button type="submit" class="send-button" disabled={!canSend} aria-label="Send message" title="Send message (Ctrl/⌘+Enter)">
      <Icon name="send" />
    </button>
  </div>
  {#if error}
    <p class="composer-error" role="alert">{error}</p>
  {/if}
</form>
