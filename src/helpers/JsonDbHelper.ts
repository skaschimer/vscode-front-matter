import { ConfigWithAdapter, FileAdapter, IAdapter, JsonDB } from 'node-json-db';
import { ParseError, parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
import * as l10n from '@vscode/l10n';
import { LocalStore } from '../constants';
import { LocalizationKey } from '../localization';
import { join } from 'path';
import { Folders } from '../commands/Folders';
import { existsAsync, readFileAsync } from '../utils';
import { parseWinPath } from './parseWinPath';
import { Notifications } from './Notifications';
import { Logger } from './Logger';

const CONFLICT_MARKER = /^<{7}(?: |\t|$)/m;

/**
 * Adapter to store the Front Matter databases in a Git-friendly format.
 *
 * The databases live in the `.frontmatter/database` folder and are versioned by most
 * teams. Storing them on a single minified line leaves Git nothing to merge line by
 * line, so the data gets indented and its object keys sorted to keep the diffs stable.
 */
class JsonDbAdapter implements IAdapter<any> {
  private readonly dateRegex = new RegExp('^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}', 'm');

  constructor(private readonly adapter: IAdapter<string>, private readonly dbPath: string) {}

  public async readAsync(): Promise<any> {
    const data = await this.adapter.readAsync();

    if (data === null) {
      await this.writeAsync({});
      return {};
    }

    const errors: ParseError[] = [];
    const contents = parseJsonc(data, errors, { allowTrailingComma: true });

    if (errors.length > 0) {
      // Let the error bubble up, as the database stays unloaded, no write can
      // overwrite the file before the user got the chance to fix it
      const parseError = JsonDbAdapter.getParseError(data, errors[0]);
      this.notifyCorrupted(data, parseError);
      throw new Error(`Failed to parse "${this.dbPath}": ${parseError}`);
    }

    return this.revive(contents);
  }

  public writeAsync(data: any): Promise<void> {
    // The trailing newline keeps the file from showing up as changed in every diff
    return this.adapter.writeAsync(`${JSON.stringify(data, JsonDbAdapter.replacer, 2)}\n`);
  }

  /**
   * Sort the object keys, so that the same data always writes the same file
   */
  private static replacer(_: string, value: any) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return value;
    }

    return Object.keys(value)
      .sort()
      .reduce((sorted: Record<string, any>, key: string) => {
        sorted[key] = value[key];
        return sorted;
      }, {});
  }

  /**
   * Turn the date strings back into dates, as the JSONC parser takes no reviver
   */
  private revive(value: any): any {
    if (typeof value === 'string') {
      return this.dateRegex.exec(value) !== null ? new Date(value) : value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.revive(item));
    }

    if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        value[key] = this.revive(value[key]);
      }
    }

    return value;
  }

  /**
   * Point the user to the place where the file breaks, a line and column are
   * easier to find back than the character offset
   */
  private static getParseError(contents: string, error: ParseError) {
    const upToError = contents.substring(0, error.offset);
    const line = upToError.split('\n').length;
    const column = error.offset - upToError.lastIndexOf('\n');

    return `${printParseErrorCode(error.error)} at line ${line}, column ${column}`;
  }

  /**
   * Tell the user which file is broken and why, instead of failing silently
   */
  private notifyCorrupted(contents: string, error: string) {
    const localPath = JsonDbAdapter.getLocalPath(this.dbPath);

    const message = CONFLICT_MARKER.test(contents)
      ? l10n.t(LocalizationKey.helpersJsonDbHelperConflictError, localPath)
      : l10n.t(LocalizationKey.helpersJsonDbHelperParseError, localPath, error);

    Notifications.errorShowOnce(message);
  }

  /**
   * Show the path relative to the project, as that is how the user knows the file
   */
  private static getLocalPath(dbPath: string) {
    const path = parseWinPath(dbPath);
    const idx = path.indexOf(`/${LocalStore.rootFolder}/`);
    return idx > -1 ? path.substring(idx + 1) : path;
  }
}

/**
 * Create a database for one of the files in the `.frontmatter/database` folder
 * @param dbPath
 * @returns
 */
export const createJsonDb = (dbPath: string): JsonDB => {
  const adapter = new JsonDbAdapter(new FileAdapter(dbPath, false), dbPath);
  return new JsonDB(new ConfigWithAdapter(adapter, true, '/'));
};

/**
 * Rewrite the databases which are still stored on a single line
 *
 * Without this, the files only get reformatted once the extension writes to them,
 * which spreads the change out over whenever someone happens to add a tag or edit
 * the metadata of a media file
 */
export const reformatJsonDbs = async (): Promise<void> => {
  const wsFolder = Folders.getWorkspaceFolder();
  if (!wsFolder) {
    return;
  }

  const dbFolder = join(
    parseWinPath(wsFolder.fsPath),
    LocalStore.rootFolder,
    LocalStore.databaseFolder
  );

  const dbFiles = [
    LocalStore.taxonomyDatabaseFile,
    LocalStore.mediaDatabaseFile,
    LocalStore.pinnedItemsDatabaseFile
  ];

  for (const dbFile of dbFiles) {
    const dbPath = join(dbFolder, dbFile);

    // Only touch the files which are already there, creating the missing ones would
    // add files to the project which the user never used
    if (!(await existsAsync(dbPath))) {
      continue;
    }

    try {
      const contents = await readFileAsync(dbPath, 'utf8');
      if (contents.startsWith(`{\n`)) {
        continue;
      }

      const db = createJsonDb(dbPath);
      // Loading first is crucial, saving an unloaded database writes an empty object
      await db.load();
      await db.save();

      Logger.info(`Reformatted "${dbFile}" to be able to merge it line by line`);
    } catch (err) {
      // The read already told the user which file is broken and why
      Logger.error(`Failed to reformat "${dbFile}": ${(err as Error).message}`);
    }
  }
};
