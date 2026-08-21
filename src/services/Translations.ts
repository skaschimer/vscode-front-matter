import { ExtensionState } from '../constants';
import { Extension } from '../helpers';

export class Translations {
  /**
   * The maximum number of texts which can be sent in a single request.
   * DeepL allows 50 text parameters, Azure allows 1000 array elements.
   */
  private static readonly maxBatchSize = 40;
  /**
   * The maximum number of characters which can be sent in a single request.
   * Azure allows 50.000 characters per request.
   */
  private static readonly maxBatchLength = 40000;

  /**
   * Translates an array of text from a source language to a target language.
   * @param text - The array of text to be translated.
   * @param source - The source language code.
   * @param target - The target language code.
   * @returns A Promise that resolves to an array of translated text, or undefined if translation is not possible.
   */
  public static async translate(
    text: string[],
    source: string,
    target: string
  ): Promise<string[] | undefined> {
    const deeplAuthKey = await Extension.getInstance().getSecret(
      ExtensionState.Secrets.Deepl.ApiKey
    );
    const azureAuthKey = await Extension.getInstance().getSecret(
      ExtensionState.Secrets.Azure.TranslatorKey
    );
    const azureRegion = await Extension.getInstance().getSecret(
      ExtensionState.Secrets.Azure.TranslatorRegion
    );

    if (!text || text.length === 0) {
      return [];
    }

    const translations: string[] = [];

    for (const batch of Translations.createBatches(text)) {
      let translated: string[] | undefined;

      if (azureAuthKey && azureRegion) {
        translated = await this.translateAzure(batch, source, target, azureAuthKey, azureRegion);
      } else if (deeplAuthKey) {
        translated = await this.translateDeepL(batch, source, target, deeplAuthKey);
      } else {
        return;
      }

      if (!translated || translated.length !== batch.length) {
        throw new Error('Invalid response');
      }

      translations.push(...translated);
    }

    return translations;
  }

  /**
   * Splits the texts into batches which stay within the limits of the translation services.
   * @param text - The array of text to be translated.
   * @returns An array of batches.
   */
  private static createBatches(text: string[]): string[][] {
    const batches: string[][] = [];

    let batch: string[] = [];
    let batchLength = 0;

    for (const value of text) {
      const valueLength = value?.length || 0;

      if (
        batch.length > 0 &&
        (batch.length >= Translations.maxBatchSize ||
          batchLength + valueLength > Translations.maxBatchLength)
      ) {
        batches.push(batch);
        batch = [];
        batchLength = 0;
      }

      batch.push(value);
      batchLength += valueLength;
    }

    if (batch.length > 0) {
      batches.push(batch);
    }

    return batches;
  }

  /**
   * Translates an array of text using Azure Cognitive Services Translator API.
   * @param text - The array of text to be translated.
   * @param source - The source language code.
   * @param target - The target language code.
   * @param azureAuthKey - The Azure authentication key.
   * @param azureRegion - The Azure region for the translation service.
   * @returns A promise that resolves to an array of translated text.
   * @throws An error if the translation fails.
   */
  private static async translateAzure(
    text: string[],
    source: string,
    target: string,
    azureAuthKey: string,
    azureRegion: string
  ): Promise<string[]> {
    try {
      const body = JSON.stringify(text.map((t) => ({ Text: t })));

      const response = await fetch(
        `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${target}&from=${source}&textType=html`,
        {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': azureAuthKey,
            'Ocp-Apim-Subscription-Region': azureRegion,
            'Content-Type': 'application/json; charset=UTF-8'
          },
          body
        }
      );

      if (!response.ok) {
        throw new Error(`${response.statusText}`);
      }

      const data = await response.json();

      return data.map((t: { translations: { text: string }[] }) => t.translations[0].text);
    } catch (error) {
      throw new Error(`Azure: ${(error as Error).message}`);
    }
  }

  /**
   * Translates an array of text using the DeepL translation service.
   * @param text - The text to be translated.
   * @param source - The source language of the text.
   * @param target - The target language for the translation.
   * @param deeplAuthKey - The authentication key for accessing the DeepL API.
   * @returns A Promise that resolves to an array of translated text.
   * @throws If there is an error during the translation process.
   */
  private static async translateDeepL(
    text: string[],
    source: string,
    target: string,
    deeplAuthKey: string
  ): Promise<string[]> {
    try {
      const body = JSON.stringify({
        text,
        source_lang: source,
        target_lang: target
      });

      const host = deeplAuthKey.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';

      const response = await fetch(`https://${host}/v2/translate`, {
        method: 'POST',
        headers: {
          Authorization: `DeepL-Auth-Key ${deeplAuthKey}`,
          'User-Agent': `FrontMatterCMS/${Extension.getInstance().version}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body
      });

      if (!response.ok) {
        throw new Error(`${response.statusText}`);
      }

      const data = await response.json();
      if (!data.translations) {
        throw new Error('Invalid response');
      }

      return data.translations.map((t: { text: string }) => t.text);
    } catch (error) {
      throw new Error(`DeepL: ${(error as Error).message}`);
    }
  }
}
