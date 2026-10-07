<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { MAX_IMAGES, processImage } from "../lib/image-attachment";
  import { composerState, promptResult, sendPrompt } from "../lib/controller";
  import type { BrowserPromptImage } from "../lib/types";
  import Icon from "./Icon.svelte";

  interface Attachment extends BrowserPromptImage {
    id: string;
    previewUrl: string;
  }

  interface SessionDraft {
    text: string;
    error: string;
    pendingCommandId?: string;
  }

  const drafts = new Map<string, SessionDraft>();
  let text = $state("");
  let attachments = $state<Attachment[]>([]);
  let processing = $state(false);
  let error = $state("");
  let fileInput: HTMLInputElement;
  let textarea: HTMLTextAreaElement;
  let fullscreenTextarea: HTMLTextAreaElement;
  let fullscreenDialog: HTMLDialogElement;
  let previousSelectedId: string | undefined;
  let hasSelectedSession = false;
  let attachmentEpoch = 0;
  let destroyed = false;
  let pendingCommandId = $state<string>();
  let canExpand = $state(false);
  let expanded = $state(false);
  const COMPOSER_MAX_HEIGHT = 180;

  $effect(() => {
    const selectedId = $composerState.selectedId;
    if (hasSelectedSession && previousSelectedId !== selectedId) {
      if (previousSelectedId) drafts.set(previousSelectedId, { text, error, pendingCommandId });
      attachmentEpoch += 1;
      clearAttachments();
      const nextDraft = selectedId ? drafts.get(selectedId) : undefined;
      text = nextDraft?.text ?? "";
      pendingCommandId = nextDraft?.pendingCommandId;
      closeFullscreen(false);
      error = nextDraft?.error ?? "";
    }
    previousSelectedId = selectedId;
    hasSelectedSession = true;
  });

  $effect(() => {
    if (!$composerState.supportsImages && attachments.length > 0) {
      attachmentEpoch += 1;
      clearAttachments();
      error = "The selected model does not support images.";
    }
  });

  $effect(() => {
    if ($composerState.connected) return;
    const connectionError = "Connection lost before Pi acknowledged the message. You can retry it.";
    if (pendingCommandId) {
      pendingCommandId = undefined;
      error = connectionError;
    }
    for (const [instanceId, draft] of drafts) {
      if (!draft.pendingCommandId) continue;
      drafts.set(instanceId, { ...draft, pendingCommandId: undefined, error: connectionError });
    }
  });

  $effect(() => {
    const result = $promptResult;
    if (!result) return;
    if (result.commandId === pendingCommandId) {
      pendingCommandId = undefined;
      if (result.ok) {
        text = "";
        clearAttachments();
        error = "";
      } else {
        error = result.error || "Pi did not accept the message. You can retry it.";
      }
      if ($composerState.selectedId) drafts.set($composerState.selectedId, { text, error, pendingCommandId });
      return;
    }
    for (const [instanceId, draft] of drafts) {
      if (draft.pendingCommandId !== result.commandId) continue;
      drafts.set(instanceId, result.ok
        ? { text: "", error: "", pendingCommandId: undefined }
        : { ...draft, error: result.error || "Pi did not accept the message. You can retry it.", pendingCommandId: undefined });
      break;
    }
  });

  $effect(() => {
    text;
    expanded;
    void tick().then(resizeTextarea);
  });

  $effect(() => {
    document.documentElement.classList.toggle("composer-fullscreen", expanded);
    return () => document.documentElement.classList.remove("composer-fullscreen");
  });

  onDestroy(() => {
    destroyed = true;
    attachmentEpoch += 1;
    if (fullscreenDialog?.open) closeDialogElement();
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
    if ($composerState.selectedId) drafts.set($composerState.selectedId, { text, error: "", pendingCommandId });
    closeFullscreen(false);
    error = "";
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && expanded) {
      event.preventDefault();
      void toggleExpanded();
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  function resizeTextarea(): void {
    if (!textarea) return;
    textarea.style.height = "auto";
    const scrollHeight = textarea.scrollHeight;
    canExpand = scrollHeight > COMPOSER_MAX_HEIGHT;
    textarea.style.height = `${Math.min(scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
    textarea.style.overflowY = canExpand ? "auto" : "hidden";
  }

  async function toggleExpanded(): Promise<void> {
    if (expanded) {
      closeFullscreen();
      return;
    }
    expanded = true;
    await tick();
    if (!fullscreenDialog.open) openDialogElement();
    fullscreenTextarea.focus();
    fullscreenTextarea.setSelectionRange(text.length, text.length);
  }

  function closeFullscreen(restoreFocus = true): void {
    expanded = false;
    if (fullscreenDialog?.open) closeDialogElement();
    if (restoreFocus) void tick().then(() => textarea?.focus());
  }

  function openDialogElement(): void {
    if (typeof fullscreenDialog.showModal === "function") fullscreenDialog.showModal();
    else fullscreenDialog.setAttribute("open", "");
  }

  function closeDialogElement(): void {
    if (typeof fullscreenDialog.close === "function") fullscreenDialog.close();
    else fullscreenDialog.removeAttribute("open");
  }

  function cancelFullscreen(event: Event): void {
    event.preventDefault();
    closeFullscreen();
  }

  const stackControls = $derived(attachments.length > 0);
  const canOpenAttachment = $derived($composerState.connected && !processing && !pendingCommandId && attachments.length < MAX_IMAGES);
  const canSend = $derived(
    $composerState.connected
      && Boolean($composerState.selectedId)
      && !processing
      && !pendingCommandId
      && (text.trim().length > 0 || attachments.length > 0),
  );
</script>

<form
  id="prompt-form"
  class="composer composer-rich"
  class:composer-has-attachments={stackControls}
  class:composer-expanded={expanded}
  onsubmit={(event) => { event.preventDefault(); submit(); }}
>
  <input
    class="image-input"
    bind:this={fileInput}
    type="file"
    accept="image/*"
    multiple
    onchange={chooseFiles}
    aria-label="Choose images"
  />
  <div class="composer-field">
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

    <div class="composer-editor">
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
    </div>

    <button
      type="button"
      class="attach-button"
      disabled={!canOpenAttachment}
      aria-label="Attach images"
      title={$composerState.supportsImages ? `Attach up to ${MAX_IMAGES} images` : "Image input unavailable for this process/model"}
      onclick={openImagePicker}
    >
      <Icon name="plus" />
    </button>

    {#if canExpand}
      <button
        type="button"
        class="expand-composer-button"
        aria-label="Open full-screen editor"
        aria-expanded={expanded}
        title="Open full screen"
        onpointerdown={(event) => event.preventDefault()}
        onclick={toggleExpanded}
      >
        <Icon name="expand" />
      </button>
    {/if}

    <button type="submit" class="send-button" disabled={!canSend} aria-label="Send message" title="Send message (Ctrl/⌘+Enter)">
      <Icon name="send" />
    </button>
  </div>
  {#if error}
    <p class="composer-error" role="alert">{error}</p>
  {/if}
</form>

<dialog
  class="composer-fullscreen-dialog"
  bind:this={fullscreenDialog}
  aria-label="Full-screen message editor"
  oncancel={cancelFullscreen}
  onclose={() => { expanded = false; }}
>
  <div class="composer-fullscreen-surface">
    <textarea
      class="composer-fullscreen-textarea"
      bind:this={fullscreenTextarea}
      bind:value={text}
      placeholder="Message Pi…"
      aria-label="Message Pi full screen"
      disabled={!$composerState.selectedId || Boolean(pendingCommandId)}
      onkeydown={keydown}
    ></textarea>
    <button
      type="button"
      class="fullscreen-collapse-button"
      aria-label="Exit full-screen editor"
      aria-expanded="true"
      title="Exit full screen"
      onclick={() => closeFullscreen()}
    >
      <Icon name="collapse" />
    </button>
    <button
      type="button"
      class="send-button fullscreen-send-button"
      disabled={!canSend}
      aria-label="Send message"
      title="Send message (Ctrl/⌘+Enter)"
      onclick={submit}
    >
      <Icon name="send" />
    </button>
  </div>
</dialog>
