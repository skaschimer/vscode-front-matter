import * as React from 'react';
import * as l10n from '@vscode/l10n';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Messenger, messageHandler } from '@estruyf/vscode/dist/client';
import { useRecoilValue } from 'recoil';
import { CodeBracketIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { basename } from 'path';
import { DashboardMessage } from '../../DashboardMessage';
import { LocalizationKey } from '../../../localization';
import { MediaInfo, Snippet } from '../../../models';
import { SelectedMediaFolderAtom, SettingsSelector, ViewDataSelector } from '../../state';
import useMediaFolder from '../../hooks/useMediaFolder';
import { getRelPath } from '../../utils';
import { parseWinPath } from '../../../helpers/parseWinPath';
import { SnippetParser } from '../../../helpers/SnippetParser';
import { DetailsForm } from './DetailsForm';
import { MediaSnippetForm } from './MediaSnippetForm';
import { InfoDialog } from '../Modals/InfoDialog';

export interface IMediaPastePanelProps { }

type PasteStep = 'folder' | 'metadata' | 'snippet' | 'snippetForm';

/**
 * Panel which guides the pasted media through picking a folder, adding the
 * metadata, and inserting it into the content file it was pasted in.
 */
export const MediaPastePanel: React.FunctionComponent<IMediaPastePanelProps> = () => {
  const viewData = useRecoilValue(ViewDataSelector);
  const settings = useRecoilValue(SettingsSelector);
  const selectedFolder = useRecoilValue(SelectedMediaFolderAtom);
  const { updateFolder } = useMediaFolder();

  const [dismissed, setDismissed] = useState(false);
  const [step, setStep] = useState<PasteStep>('folder');
  const [storing, setStoring] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [storedMedia, setStoredMedia] = useState<MediaInfo | undefined>(undefined);
  const [metadata, setMetadata] = useState<{ [fieldName: string]: string }>({});
  const [snippet, setSnippet] = useState<Snippet | undefined>(undefined);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [mediaData, setMediaData] = useState<any | undefined>(undefined);

  const pendingUpload = useMemo(() => viewData?.data?.pendingUpload, [viewData]);
  const suggestedFolder = useMemo(() => viewData?.data?.suggestedFolder, [viewData]);

  const relFolder = useMemo(() => {
    if (!selectedFolder) {
      return undefined;
    }

    const wsFolder = settings?.wsFolder;
    const folder = wsFolder ? selectedFolder.replace(wsFolder, '') : selectedFolder;
    return folder || '/';
  }, [selectedFolder, settings?.wsFolder]);

  const mediaSnippets = useMemo(() => {
    if (!settings?.snippets) {
      return [];
    }

    const keys = Object.keys(settings.snippets);
    return keys
      .filter((key) => (settings.snippets || {})[key].isMediaSnippet)
      .map((key) => ({ title: key, ...(settings.snippets || {})[key] }));
  }, [settings]);

  const relPath = useMemo(() => {
    if (!storedMedia) {
      return undefined;
    }

    return getRelPath(storedMedia.fsPath, settings?.staticFolder, settings?.wsFolder);
  }, [storedMedia, settings?.staticFolder, settings?.wsFolder]);

  // Every paste starts the flow over again
  useEffect(() => {
    setDismissed(false);
    setStep('folder');
    setStoredMedia(undefined);
    setMetadata({});
    setSnippet(undefined);
    setMediaData(undefined);
    setError(undefined);
  }, [pendingUpload?.contents]);

  // Start the user off in the page bundle or public folder
  useEffect(() => {
    if (pendingUpload && suggestedFolder && suggestedFolder !== selectedFolder) {
      updateFolder(suggestedFolder);
    }
  }, [pendingUpload, suggestedFolder]);

  const onStore = useCallback(async () => {
    if (!pendingUpload || !selectedFolder) {
      return;
    }

    setStoring(true);
    setError(undefined);

    try {
      const media = await messageHandler.request<MediaInfo>(DashboardMessage.uploadPastedMedia, {
        fileName: pendingUpload.fileName,
        contents: pendingUpload.contents,
        folder: selectedFolder
      });

      setStoredMedia(media);
      setStep('metadata');
    } catch {
      setError(l10n.t(LocalizationKey.dashboardMediaPasteError));
    } finally {
      setStoring(false);
    }
  }, [pendingUpload, selectedFolder]);

  const insertMedia = useCallback(
    (fields: { [fieldName: string]: string }) => {
      Messenger.send(DashboardMessage.insertMedia, {
        relPath: parseWinPath(relPath) || '',
        file: viewData?.data?.filePath,
        fieldName: viewData?.data?.fieldName,
        position: viewData?.data?.position || null,
        alt: fields?.alt || '',
        caption: fields?.caption || '',
        title: fields?.title || ''
      });

      setDismissed(true);
    },
    [relPath, viewData]
  );

  const insertSnippet = useCallback(
    (output: string) => {
      Messenger.send(DashboardMessage.insertMedia, {
        relPath: parseWinPath(relPath) || '',
        file: viewData?.data?.filePath,
        fieldName: viewData?.data?.fieldName,
        position: viewData?.data?.position || null,
        snippet: output
      });

      setDismissed(true);
    },
    [relPath, viewData]
  );

  const onMetadataSubmitted = useCallback(
    (fields: { [fieldName: string]: string }) => {
      setMetadata(fields);

      // Without media snippets there is nothing to pick from
      if (mediaSnippets.length === 0) {
        insertMedia(fields);
        return;
      }

      setStep('snippet');
    },
    [mediaSnippets, insertMedia]
  );

  const processSnippet = useCallback(
    (mediaSnippet: Snippet) => {
      const fieldData = {
        mediaUrl: (parseWinPath(relPath) || '').replace(/ /g, '%20'),
        filename: basename(relPath || ''),
        mediaWidth: storedMedia?.dimensions?.width?.toString() || '',
        mediaHeight: storedMedia?.dimensions?.height?.toString() || '',
        ...metadata
      };

      if (!mediaSnippet.fields || mediaSnippet.fields.length === 0) {
        insertSnippet(
          SnippetParser.render(
            mediaSnippet.body,
            fieldData,
            mediaSnippet?.openingTags,
            mediaSnippet?.closingTags
          )
        );
        return;
      }

      setSnippet(mediaSnippet);
      setMediaData(fieldData);
      setStep('snippetForm');
    },
    [relPath, storedMedia, metadata, insertSnippet]
  );

  if (!pendingUpload || dismissed) {
    return null;
  }

  if (step === 'snippetForm' && storedMedia && snippet && mediaData) {
    return (
      <MediaSnippetForm
        media={storedMedia}
        mediaData={mediaData}
        snippet={snippet}
        onDismiss={() => setStep('snippet')}
        onInsert={insertSnippet}
      />
    );
  }

  if (step === 'snippet') {
    return (
      <InfoDialog
        icon={<CodeBracketIcon className="h-6 w-6" aria-hidden="true" />}
        title={l10n.t(LocalizationKey.dashboardMediaPasteSnippetTitle)}
        description={l10n.t(LocalizationKey.dashboardMediaPasteSnippetDescription)}
        dismiss={() => setDismissed(true)}
      >
        <ul className="flex flex-wrap justify-center">
          <li className="inline-flex items-center pb-2 mr-2">
            <button
              className={`w-full inline-flex justify-center border border-transparent shadow-sm px-4 py-2 text-base font-medium focus:outline-none sm:w-auto sm:text-sm bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]`}
              onClick={() => insertMedia(metadata)}
            >
              {l10n.t(LocalizationKey.dashboardMediaPasteSnippetNone)}
            </button>
          </li>

          {mediaSnippets.map((mediaSnippet, idx) => (
            <li key={idx} className="inline-flex items-center pb-2 mr-2">
              <button
                className={`w-full inline-flex justify-center border border-transparent shadow-sm px-4 py-2 text-base font-medium focus:outline-none sm:w-auto sm:text-sm disabled:opacity-30 bg-[var(--frontmatter-button-background)] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)]`}
                onClick={() => processSnippet(mediaSnippet)}
              >
                {mediaSnippet.title}
              </button>
            </li>
          ))}
        </ul>
      </InfoDialog>
    );
  }

  if (step === 'metadata' && storedMedia) {
    return (
      <div className={`fixed inset-0 z-50 flex items-center justify-center bg-[var(--vscode-editor-background)] bg-opacity-75`}>
        <div className={`w-full max-w-md max-h-full overflow-y-auto rounded border p-6 shadow-xl bg-[var(--vscode-sideBar-background)] border-[var(--frontmatter-border)]`}>
          <DetailsForm
            media={storedMedia}
            isImageFile={true}
            isVideoFile={false}
            submitLabel={
              mediaSnippets.length > 0
                ? l10n.t(LocalizationKey.commonSave)
                : l10n.t(LocalizationKey.dashboardMediaPasteSaveAndInsert)
            }
            onSubmitted={onMetadataSubmitted}
            onDismiss={() => setDismissed(true)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={`mb-6 flex items-center gap-4 rounded border p-4 border-[var(--frontmatter-border)] bg-[var(--vscode-sideBar-background)]`}>
      <img
        src={pendingUpload.contents}
        alt={pendingUpload.fileName}
        className={`h-20 w-20 object-contain border border-[var(--frontmatter-border)]`}
      />

      <div className="flex-1 min-w-0">
        <h2 className={`text-base font-medium text-[var(--frontmatter-text)]`}>
          {l10n.t(LocalizationKey.dashboardMediaPasteTitle)}
        </h2>
        <p className={`text-sm text-[var(--vscode-editor-foreground)] opacity-80`}>
          {l10n.t(LocalizationKey.dashboardMediaPasteDescription)}
        </p>
        <p className={`mt-1 text-sm truncate text-[var(--vscode-editor-foreground)]`}>
          {relFolder
            ? l10n.t(LocalizationKey.dashboardMediaPasteStoreIn, relFolder)
            : l10n.t(LocalizationKey.dashboardMediaPasteNoFolder)}
        </p>
        {error && (
          <p className={`mt-1 text-sm text-[var(--vscode-statusBarItem-errorBackground)]`}>{error}</p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          className={`inline-flex justify-center rounded px-4 py-2 text-sm font-medium disabled:opacity-30 bg-[var(--frontmatter-button-background)] hover:bg-[var(--vscode-button-hoverBackground)] text-[var(--vscode-button-foreground)]`}
          onClick={onStore}
          disabled={!selectedFolder || storing}
        >
          {storing
            ? l10n.t(LocalizationKey.dashboardMediaPasteStoring)
            : l10n.t(LocalizationKey.dashboardMediaPasteStore)}
        </button>

        <button
          type="button"
          className={`focus:outline-none text-[var(--vscode-titleBar-inactiveForeground)] hover:text-[var(--vscode-titleBar-activeForeground)]`}
          onClick={() => setDismissed(true)}
        >
          <span className="sr-only">{l10n.t(LocalizationKey.commonCancel)}</span>
          <XMarkIcon className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};
