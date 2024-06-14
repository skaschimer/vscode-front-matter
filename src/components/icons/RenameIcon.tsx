import * as React from 'react';

export interface IRenameIconProps {
  className: string;
}

export const RenameIcon: React.FunctionComponent<IRenameIconProps> = ({
  className
}: React.PropsWithChildren<IRenameIconProps>) => {
  return (
    <svg className={className} fill="currentColor" aria-hidden="true" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path d="M8.5 2a.5.5 0 0 0 0 1h1v14h-1a.5.5 0 0 0 0 1h3a.5.5 0 0 0 0-1h-1V3h1a.5.5 0 0 0 0-1h-3Zm-4 2h4v1h-4C3.67 5 3 5.67 3 6.5v7c0 .83.67 1.5 1.5 1.5h4v1h-4A2.5 2.5 0 0 1 2 13.5v-7A2.5 2.5 0 0 1 4.5 4Zm11 11h-4v1h4a2.5 2.5 0 0 0 2.5-2.5v-7A2.5 2.5 0 0 0 15.5 4h-4v1h4c.83 0 1.5.67 1.5 1.5v7c0 .83-.67 1.5-1.5 1.5Z" fill="currentColor"></path></svg>
  );
};