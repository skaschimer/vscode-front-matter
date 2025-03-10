import { formatInTimezone } from '../utils';

/**
 * Replace the datetime placeholders
 * @param value
 * @param dateFormat
 * @param articleDate
 * @returns
 */
export const processDateTimePlaceholders = (value: string, articleDate?: Date) => {
  if (value && typeof value === 'string') {
    if (value.includes(`{{date|`)) {
      const regex = /{{date\|[^}]*}}/g;
      const matches = value.match(regex);
      if (matches) {
        for (const match of matches) {
          const placeholderParts = match.split('|');
          if (placeholderParts.length > 1) {
            const dateFormat = placeholderParts[1].trim().replace('}}', '');

            if (dateFormat) {
              if (dateFormat && typeof dateFormat === 'string') {
                const formattedDate = formatInTimezone(articleDate || new Date(), dateFormat);
                value = value.replace(match, formattedDate);
              } else {
                value = value.replace(match, (articleDate || new Date()).toISOString());
              }
            }
          }
        }
      }
    }
  }

  return value;
};
