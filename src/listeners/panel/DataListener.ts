import { DataFileHelper } from './../../helpers/DataFileHelper';
import { BlockFieldData } from './../../models/BlockFieldData';
import { ImageHelper } from './../../helpers/ImageHelper';
import { Folders } from '../../commands/Folders';
import { Command } from '../../panelWebView/Command';
import { CommandToCode } from '../../panelWebView/CommandToCode';
import { BaseListener } from './BaseListener';
import { Uri, authentication, commands, window } from 'vscode';
import {
  ArticleHelper,
  Extension,
  Logger,
  Settings,
  ContentType,
  processArticlePlaceholdersFromData,
  processTimePlaceholders,
  processFmPlaceholders,
  parseWinPath,
  Questions
} from '../../helpers';
import {
  COMMAND_NAME,
  DefaultFields,
  FEATURE_FLAG,
  SETTING_COMMA_SEPARATED_FIELDS,
  SETTING_DATE_FORMAT,
  SETTING_GLOBAL_ACTIVE_MODE,
  SETTING_GLOBAL_MODES,
  SETTING_TAXONOMY_CONTENT_TYPES
} from '../../constants';
import { Article, Preview } from '../../commands';
import { FrontMatterParser, ParsedFrontMatter } from '../../parsers';
import {
  Field,
  Mode,
  PostMessageData,
  ContentType as IContentType,
  FolderInfo
} from '../../models';
import { encodeEmoji, fieldWhenClause, getTitleField } from '../../utils';
import { PanelProvider } from '../../panelWebView/PanelProvider';
import { MessageHandlerData } from '@estruyf/vscode';
import { SponsorAi } from '../../services/SponsorAI';
import { Terminal } from '../../services';
import * as l10n from '@vscode/l10n';
import { LocalizationKey } from '../../localization';
import { parse } from 'path';
import { Copilot } from '../../services/Copilot';

const FILE_LIMIT = 10;

export class DataListener extends BaseListener {
  private static lastMetadataUpdate: any = {};
  private static folderInfo: FolderInfo[] | null = null;

  /**
   * Process the messages for the dashboard views
   * @param msg
   */
  public static process(msg: PostMessageData) {
    super.process(msg);

    switch (msg.command) {
      case CommandToCode.getData:
        this.getFoldersAndFiles();
        this.getFileData();
        break;
      case CommandToCode.createContent:
        commands.executeCommand(COMMAND_NAME.createContent);
        break;
      case CommandToCode.createTemplate:
        commands.executeCommand(COMMAND_NAME.createTemplate);
        break;
      case CommandToCode.updateMetadata:
        this.updateMetadata(msg.payload);
        break;
      case CommandToCode.frameworkCommand:
        this.openTerminalWithCommand(msg.payload.command);
        break;
      case CommandToCode.stopServer:
        this.stopServer();
        break;
      case CommandToCode.isServerStarted:
        this.isServerStarted(msg.command, msg?.requestId);
        break;
      case CommandToCode.updatePlaceholder:
        this.updatePlaceholder(
          msg.command,
          msg.payload as { field: string; value: string; data: { [key: string]: any } },
          msg.requestId
        );
        break;
      case CommandToCode.generateContentType:
        commands.executeCommand(COMMAND_NAME.generateContentType);
        break;
      case CommandToCode.addMissingFields:
        commands.executeCommand(COMMAND_NAME.addMissingFields);
        break;
      case CommandToCode.setContentType:
        commands.executeCommand(COMMAND_NAME.setContentType);
        break;
      case CommandToCode.getDataEntries:
        this.getDataFileEntries(msg.command, msg.requestId || '', msg.payload);
        break;
      case CommandToCode.aiSuggestDescription:
        this.aiSuggestTaxonomy(msg.command, msg.requestId);
        break;
      case CommandToCode.copilotSuggestDescription:
        this.copilotSuggestDescription(msg.command, msg.requestId);
        break;
      case CommandToCode.copilotSuggestTitle:
        this.copilotSuggestTitle(msg.command, msg.requestId, msg.payload);
        break;
    }
  }

  private static async copilotSuggestTitle(command: string, requestId?: string, title?: string) {
    if (!command || !requestId) {
      return;
    }

    if (!title) {
      this.sendRequestError(command, requestId, 'No title provided');
      return;
    }

    const aiTitles = await Copilot.suggestTitles(title);
    title = await Questions.pickTitleSuggestions(title, aiTitles || [], true);

    if (title) {
      this.sendRequest(command, requestId, title);
    } else {
      this.sendRequestError(command, requestId, 'Failed to suggest title');
    }
  }

  /**
   * Executes a Copilot suggestion command.
   * @param command - The command to execute.
   * @param requestId - The optional request ID.
   * @returns A Promise that resolves when the suggestion command is executed.
   */
  private static async copilotSuggestDescription(command: string, requestId?: string) {
    if (!command || !requestId) {
      return;
    }

    const article = ArticleHelper.getActiveFile();
    if (!article) {
      return;
    }

    const articleDetails = await ArticleHelper.getFrontMatterByPath(article);
    if (!articleDetails) {
      return;
    }

    const extPath = Extension.getInstance().extensionPath;
    const panel = PanelProvider.getInstance(extPath);

    const titleField = getTitleField();
    const description = await Copilot.suggestDescription(
      articleDetails.data[titleField],
      articleDetails.content
    );

    if (description) {
      panel.getWebview()?.postMessage({
        command,
        requestId,
        payload: description
      } as MessageHandlerData<string>);
    } else {
      panel.getWebview()?.postMessage({
        command,
        requestId,
        error: l10n.t(LocalizationKey.servicesCopilotGetChatResponseError)
      } as MessageHandlerData<string>);
    }
  }

  /**
   * Suggests taxonomy using AI.
   * @param command - The command string.
   * @param requestId - The optional request ID.
   */
  private static async aiSuggestTaxonomy(command: string, requestId?: string) {
    if (!command || !requestId) {
      return;
    }

    const extPath = Extension.getInstance().extensionPath;
    const panel = PanelProvider.getInstance(extPath);

    const editor = window.activeTextEditor;
    if (!editor) {
      panel.getWebview()?.postMessage({
        command,
        requestId,
        error: l10n.t(LocalizationKey.listenersPanelDataListenerAiSuggestTaxonomyNoEditorError)
      } as MessageHandlerData<string>);
      return;
    }

    const article = ArticleHelper.getFrontMatter(editor);
    if (!article || !article.data) {
      panel.getWebview()?.postMessage({
        command,
        requestId,
        error: l10n.t(LocalizationKey.listenersPanelDataListenerAiSuggestTaxonomyNoDataError)
      } as MessageHandlerData<string>);
      return;
    }

    const githubAuth = await authentication.getSession('github', ['read:user'], { silent: true });
    if (!githubAuth || !githubAuth.accessToken) {
      return;
    }

    const titleField = getTitleField();

    const suggestion = await SponsorAi.getDescription(
      githubAuth.accessToken,
      article.data[titleField] || '',
      article.content || ''
    );

    if (!suggestion) {
      panel.getWebview()?.postMessage({
        command,
        requestId,
        error: l10n.t(LocalizationKey.listenersPanelDataListenerAiSuggestTaxonomyNoDataError)
      } as MessageHandlerData<string>);
      return;
    }

    panel.getWebview()?.postMessage({
      command,
      requestId,
      payload: suggestion || []
    } as MessageHandlerData<string>);
  }

  /**
   * Retrieve the information about the registered folders and its files
   */
  public static async getFoldersAndFiles(file?: Uri) {
    Logger.verbose('DataListener:getFoldersAndFiles:start');
    const mode = Settings.get<string | null>(SETTING_GLOBAL_ACTIVE_MODE);
    const modes = Settings.get<Mode[]>(SETTING_GLOBAL_MODES);

    if (mode && modes && modes.length > 0) {
      const crntMode = modes.find((m) => m.id === mode);
      if (crntMode) {
        const recentlyModified = crntMode.features.find(
          (f) => f === FEATURE_FLAG.panel.recentlyModified
        );
        if (!recentlyModified) {
          this.sendMsg(Command.folderInfo, null);
          return;
        }
      }
    }

    if (file && DataListener.folderInfo && DataListener.folderInfo.length > 0) {
      Logger.verbose('DataListener:getFoldersAndFiles:updateFile');
      const folderPath = parseWinPath(parse(file.fsPath).dir);
      const folderInfo = DataListener.folderInfo.find((f) => parseWinPath(f.path) === folderPath);
      if (folderInfo) {
        // Check if file exists
        let fileInfo = folderInfo.lastModified.find(
          (f) => parseWinPath(f.filePath) === parseWinPath(file.fsPath)
        );

        if (fileInfo) {
          folderInfo.lastModified = folderInfo.lastModified.filter(
            (f) => parseWinPath(f.filePath) !== parseWinPath(file.fsPath)
          );
        }

        fileInfo = await Folders.getFileStats(file, folderInfo.path);
        if (fileInfo) {
          folderInfo.lastModified.unshift(fileInfo);

          // Limit the amount of files
          if (folderInfo.lastModified.length > FILE_LIMIT) {
            folderInfo.lastModified = folderInfo.lastModified.slice(0, FILE_LIMIT);
          }

          Logger.verbose('DataListener:getFoldersAndFiles:end - with file update only');
          this.sendMsg(Command.folderInfo, DataListener.folderInfo);
          return;
        }
      }
    }

    Logger.verbose('DataListener:getFoldersAndFiles:end');
    DataListener.folderInfo = (await Folders.getInfo(FILE_LIMIT)) || null;
    this.sendMsg(Command.folderInfo, DataListener.folderInfo);
  }

  /**
   * Triggers a metadata change in the panel
   * @param metadata
   */
  public static async pushMetadata(metadata: any) {
    const wsFolder = Folders.getWorkspaceFolder();
    const filePath =
      window.activeTextEditor?.document.uri.fsPath ||
      Preview.filePath ||
      ArticleHelper.getActiveFile();
    const commaSeparated = Settings.get<string[]>(SETTING_COMMA_SEPARATED_FIELDS);
    const contentTypes = Settings.get<string>(SETTING_TAXONOMY_CONTENT_TYPES);

    let articleDetails = null;

    try {
      if (filePath && !filePath.startsWith('extension-output-eliostruyf')) {
        articleDetails = await ArticleHelper.getDetails(filePath);

        if (!articleDetails || articleDetails === 'nodata') {
          try {
            const contents = await ArticleHelper.getContents(filePath);
            if (contents) {
              FrontMatterParser.fromFile(contents);
            }
          } catch (e) {
            this.sendMsg(Command.metadata, {
              fmError: l10n.t(
                LocalizationKey.listenersPanelDataListenerPushMetadataFrontMatterError
              ),
              fmErrorMessage: (e as Error).message
            });
            return;
          }
        } else if (articleDetails === 'notsupported' || articleDetails === 'nofilepath') {
          // No file or invalid file format
          this.sendMsg(Command.metadata, undefined);
          return;
        }
      } else {
        this.sendMsg(Command.metadata, undefined);
        return;
      }
    } catch (e) {
      if (filePath) {
        Logger.error(`DataListener::pushMetadata: ${(e as Error).message}`);
      }
      this.sendMsg(Command.metadata, undefined);
      return;
    }

    if (articleDetails) {
      metadata.articleDetails = articleDetails;
    }

    const updatedMetadata = Object.assign({}, metadata);
    if (commaSeparated) {
      for (const key of commaSeparated) {
        if (updatedMetadata[key] && typeof updatedMetadata[key] === 'string') {
          updatedMetadata[key] = updatedMetadata[key].split(',').map((s: string) => s.trim());
        }
      }
    }

    const keys = Object.keys(updatedMetadata);
    if (keys.length > 0) {
      updatedMetadata.filePath = filePath;
    }

    if (keys.length > 0 && contentTypes && wsFolder) {
      // Get the current content type
      const contentType = await ArticleHelper.getContentType({
        content: '',
        data: updatedMetadata,
        path: filePath
      });
      let slugField;
      if (contentType) {
        ImageHelper.processImageFields(updatedMetadata, contentType.fields);

        slugField = contentType.fields.find((f) => f.type === 'slug');
      }

      // Check slug
      if (!slugField && !updatedMetadata[DefaultFields.Slug]) {
        let pathname = contentType.previewPath || '';
        if (!pathname) {
          const selectedFolder = await Folders.getPageFolderByFilePath(filePath);
          if (selectedFolder && selectedFolder.previewPath) {
            pathname = selectedFolder.previewPath;
          }
        }

        if (!pathname) {
          pathname = Preview.getSettings().pathname || '';
        }

        const slug = Article.getSlug(pathname);

        if (typeof slug !== 'undefined') {
          updatedMetadata[DefaultFields.Slug] = slug;
        }
      }
    }

    if (filePath && updatedMetadata[DefaultFields.Slug]) {
      Preview.updatePageUrl(filePath, updatedMetadata[DefaultFields.Slug]);
    }

    this.sendMsg(Command.metadata, updatedMetadata);

    DataListener.lastMetadataUpdate = updatedMetadata;
  }

  /**
   * Update the metadata of the article
   */
  public static async updateMetadata({
    field,
    parents,
    value,
    filePath,
    blockData
  }: {
    field: string;
    value: any;
    parents?: string[];
    filePath?: string;
    blockData?: BlockFieldData;
    fieldData?: { multiple: boolean; value: string[] };
  }) {
    if (!field) {
      return;
    }

    let beforeValue: any;
    const titleField = getTitleField();

    const editor = window.activeTextEditor;

    let article;

    if (editor) {
      article = ArticleHelper.getFrontMatter(editor);
    } else if (filePath) {
      article = await ArticleHelper.getFrontMatterByPath(filePath);
    }

    if (!article) {
      return;
    }

    const contentType = await ArticleHelper.getContentType(article);
    const sourceField = ContentType.findFieldByName(contentType.fields, field);

    if (!value && field !== titleField && contentType.clearEmpty) {
      // Check if the draft or boolean field needs to be cleared
      // This is only required when the default value is not set to true
      if (sourceField && (sourceField.type === 'draft' || sourceField.type === 'boolean')) {
        if (!sourceField.default) {
          value = undefined;
        }
      } else if (sourceField?.type === 'number') {
        // We don't have to do anything for numbers, we can leave the 0 value
      } else {
        value = undefined;
      }
    }

    const imageFields = ContentType.findFieldsByTypeDeep(contentType.fields, 'image');
    const fileFields = ContentType.findFieldsByTypeDeep(contentType.fields, 'file');
    const fieldsWithEmojiEncoding = contentType.fields.filter((f) => f.encodeEmoji);

    // Support multi-level fields
    const parentObj = await DataListener.getParentObject(article.data, article, parents, blockData);

    // Check multi-image fields
    const multiImageFieldsArray = imageFields.find((f: Field[]) => {
      const lastField = f?.[f.length - 1];
      if (lastField) {
        return lastField.name === field && lastField.multiple;
      }
    });

    // Check multi-file fields
    const multiFileFieldsArray = fileFields.find((f: Field[]) => {
      const lastField = f?.[f.length - 1];
      if (lastField) {
        return lastField.name === field && lastField.multiple;
      }
    });

    // Check date fields
    if (multiImageFieldsArray || multiFileFieldsArray) {
      const fields =
        multiImageFieldsArray && multiImageFieldsArray.length > 0
          ? multiImageFieldsArray
          : multiFileFieldsArray;

      if (fields) {
        for (const crntField of fields) {
          if (field === crntField.name) {
            // If value is an array, it means it comes from the explorer view itself (deletion)
            if (Array.isArray(value)) {
              parentObj[field] = value || [];
            } else {
              // Otherwise it is coming from the media dashboard (addition)
              let fieldValue = parentObj[field];
              if (fieldValue && !Array.isArray(fieldValue)) {
                fieldValue = [fieldValue];
              }
              const crntData = Object.assign([], fieldValue);
              const allRelPaths = [...(crntData || []), value];
              parentObj[field] = [...new Set(allRelPaths)].filter((f) => f);
            }
          }
        }
      }
    } else {
      if (fieldsWithEmojiEncoding.some((f) => f.name === field)) {
        value = encodeEmoji(value);
      }

      if (Array.isArray(parentObj)) {
        parentObj.push({
          [field]: value
        });
      } else {
        beforeValue = parentObj[field];
        parentObj[field] = value;
      }
    }

    // Verify if there are fields to be cleared due to the when clause
    const allFieldNames = Object.keys(parentObj);
    let ctFields = contentType.fields;
    if (parents && parents.length > 0) {
      for (const parent of parents) {
        const crntField = ctFields.find((f) => f.name === parent);
        if (crntField) {
          ctFields = crntField.fields || [];
        }
      }
    }
    if (ctFields && ctFields.length > 0) {
      for (const field of allFieldNames) {
        const crntField = ctFields.find((f) => f.name === field);
        if (crntField && crntField.when) {
          const renderField = fieldWhenClause(crntField, parentObj, ctFields);
          if (!renderField) {
            delete parentObj[field];
          }
        }
      }
    }

    // Clear the field if it is empty
    if (
      value === undefined ||
      (value instanceof Array && value.length === 0 && contentType.clearEmpty)
    ) {
      delete parentObj[field];
    }

    if (Object.keys(parentObj).length === 0 && field !== titleField && contentType.clearEmpty) {
      delete article.data[parents![0]];
    }

    if (editor) {
      ArticleHelper.update(editor, article);
    } else if (filePath) {
      await ArticleHelper.updateByPath(filePath, article);
    }

    Logger.verbose(
      `DataListener:updateMetadata: "${field}" - Before value: ${JSON.stringify(
        beforeValue
      )} - After value: ${JSON.stringify(value)}`,
      'VSCODE'
    );

    this.pushMetadata(article.data);
  }

  /**
   * Retrieve the parent object to update
   * @param data
   * @param article
   * @param parents
   * @param blockData
   * @returns
   */
  public static async getParentObject(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: any,
    article: ParsedFrontMatter,
    parents: string[] | undefined,
    blockData?: BlockFieldData
  ) {
    let parentObj = data;
    const allParents = Object.assign([], parents);
    const contentType = await ArticleHelper.getContentType(article);
    let selectedIndexes: number[] = [];
    if (blockData?.selectedIndex) {
      if (typeof blockData.selectedIndex === 'string') {
        selectedIndexes = blockData.selectedIndex.split('.').map((v) => parseInt(v));
      } else {
        selectedIndexes = [blockData.selectedIndex];
      }
    }
    let lastSelectedIndex: number | undefined;

    // Add support for block fields
    if (blockData?.parentFields) {
      let crntField = null;
      parentObj = article.data;

      // Loop through the parents of the block field
      for (const parent of blockData?.parentFields ?? []) {
        if (!parentObj) {
          continue;
        }

        if (!parentObj[parent]) {
          if (Array.isArray(parentObj)) {
            parentObj.push({
              [parent]: []
            });
            parentObj = parentObj[parentObj.length - 1];
          } else {
            parentObj[parent] = [];
          }
        }

        if (allParents[0] && allParents[0] === parent) {
          allParents.shift();
        }

        parentObj = parentObj[parent];
        crntField = contentType.fields.find((f) => f.name === parent);

        // Check if current field is an array
        if (parentObj instanceof Array) {
          lastSelectedIndex = selectedIndexes.shift();
          if (typeof lastSelectedIndex !== 'undefined') {
            if (parentObj[lastSelectedIndex] === undefined) {
              parentObj.push({});
              parentObj = parentObj[parentObj.length - 1];
            } else {
              parentObj = parentObj[lastSelectedIndex];
            }
          }
        }
      }

      // Fetches the current block
      if (blockData && crntField && crntField.type === 'block') {
        if (typeof lastSelectedIndex === 'undefined') {
          parentObj.push({
            fieldGroup: blockData.blockType
          });
          parentObj = parentObj[parentObj.length - 1];
        }
      }

      // Check if there are parents left
      if (allParents.length > 0) {
        for (const parent of allParents) {
          if (!parentObj) {
            continue;
          }

          if (!parentObj[parent]) {
            parentObj[parent] = {};
          }

          parentObj = parentObj[parent];
        }
      }
    } else {
      for (const parent of parents || []) {
        // If parent doesn't yet exists, it needs to be created
        if (!parentObj[parent]) {
          parentObj[parent] = {};
        }

        parentObj = parentObj[parent];
      }
    }

    return parentObj;
  }

  /**
   * Retrieve the file its front matter
   */
  public static async getFileData() {
    const editor = window.activeTextEditor;
    if (!editor) {
      return '';
    }

    // Check if the file is a valid article
    if (!ArticleHelper.isSupportedFile()) {
      return;
    }

    const article = ArticleHelper.getFrontMatter(editor);
    if (article?.data) {
      this.pushMetadata(article!.data);
    }
  }

  /**
   * Retrieve the data entries from local data files
   * @param data
   */
  private static async getDataFileEntries(command: string, requestId: string, data: any) {
    if (!command || !requestId || !data) {
      return;
    }

    const entries = await DataFileHelper.getById(data);
    if (entries) {
      this.sendRequest(command, requestId, entries);
    } else {
      this.sendRequestError(
        command,
        requestId,
        l10n.t(LocalizationKey.listenersPanelDataListenerGetDataFileEntriesNoDataFilesError)
      );
    }
  }

  /**
   * Open a terminal and run the passed command
   * @param command
   */
  private static openTerminalWithCommand(command: string) {
    if (command) {
      Terminal.openLocalServerTerminal(command);
      this.sendMsg(Command.serverStarted, true);
    }
  }

  /**
   * Stop the local server
   */
  private static stopServer() {
    Terminal.closeLocalServerTerminal();
    this.sendMsg(Command.serverStarted, false);
  }

  /**
   * Checks if the server is started
   */
  private static isServerStarted(command: string, requestId?: string) {
    if (!command || !requestId) {
      return;
    }

    const localServerTerminal = Terminal.findLocalServerTerminal();
    this.sendRequest(command, requestId, !!localServerTerminal);
  }

  /**
   * Update the placeholder
   * @param field
   * @param value
   * @param title
   */
  private static async updatePlaceholder(
    command: CommandToCode,
    articleData: {
      field: string;
      value: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { [key: string]: any };
      contentType?: IContentType;
    },
    requestId?: string
  ) {
    if (!command || !requestId || !articleData) {
      return;
    }

    const { field, data, contentType } = articleData;
    let { value } = articleData;

    value = value || '';
    const valueBefore = value;
    if (field) {
      const crntFile = window.activeTextEditor?.document;
      const dateFormat = Settings.get(SETTING_DATE_FORMAT) as string;
      value =
        data && contentType
          ? processArticlePlaceholdersFromData(value, data, contentType, crntFile?.uri.fsPath)
          : value;
      value = processTimePlaceholders(value, dateFormat);
      value = processFmPlaceholders(value, data);

      const titleField = getTitleField();
      value = await ArticleHelper.processCustomPlaceholders(
        value,
        data[titleField] || '',
        crntFile?.uri.fsPath || ''
      );
    }

    Logger.verbose(
      `DataListener:updatePlaceholder: "${field}" - Before value: ${JSON.stringify(
        valueBefore
      )} - After value: ${JSON.stringify(value)}`,
      'VSCODE'
    );

    this.sendRequest(Command.updatePlaceholder, requestId, { field, value });
  }
}
