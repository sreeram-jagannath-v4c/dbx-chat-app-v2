import type {
  AnchorHTMLAttributes,
  ComponentType,
  PropsWithChildren,
  ReactNode,
} from 'react';
import { useMemo } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { cn } from '@/lib/utils';
import { parseDatabricksFileLink } from '@/lib/document-preview';
import {
  decodeDatabricksMessageCitationLink,
  isDatabricksMessageCitationLink,
} from '@/lib/message-citations';
import { useFileLinkClickHandler } from '@/contexts/DocumentPreviewContext';

/**
 * ReactMarkdown/Streamdown component that handles Databricks message citations.
 *
 * @example
 * <Streamdown components={{ a: DatabricksMessageCitationStreamdownIntegration }} />
 */
export const DatabricksMessageCitationStreamdownIntegration: ComponentType<
  AnchorHTMLAttributes<HTMLAnchorElement>
> = (props) => {
  if (isDatabricksMessageCitationLink(props.href)) {
    return (
      <DatabricksMessageCitationRenderer
        {...props}
        href={decodeDatabricksMessageCitationLink(props.href)}
      />
    );
  }
  return <DefaultAnchor {...props} />;
};

// Renders the Databricks message citation.
// Numeric labels ([1], [2], ...) render as a compact superscript badge.
const DatabricksMessageCitationRenderer = (
  props: PropsWithChildren<{
    href: string;
  }>,
) => {
  const fileDoc = useMemo(
    () => parseDatabricksFileLink(props.href),
    [props.href],
  );
  const tooltip = fileDoc
    ? `${fileDoc.fileName}${fileDoc.page ? ` · page ${fileDoc.page}` : ''}`
    : props.href;
  const isNumbered = isCitationNumberLabel(props.children);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DefaultAnchor
          href={props.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={
            isNumbered ? `Source ${props.children}: ${tooltip}` : undefined
          }
          className={
            isNumbered
              ? 'mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded bg-muted px-1 align-super font-medium text-[10px] text-muted-foreground leading-none no-underline hover:bg-primary hover:text-primary-foreground'
              : 'rounded-md bg-muted-foreground px-2 py-0 text-zinc-200'
          }
        >
          {props.children}
        </DefaultAnchor>
      </TooltipTrigger>
      <TooltipContent
        style={{ maxWidth: '300px', padding: '8px', wordWrap: 'break-word' }}
      >
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
};

const isCitationNumberLabel = (children: ReactNode) => {
  const text = Array.isArray(children) ? children.join('') : children;
  return typeof text === 'string' && /^\d+$/.test(text);
};

// Copied from streamdown
// https://github.com/vercel/streamdown/blob/dc5bd12e5709afce09814e47cf80884f8c665b3d/packages/streamdown/lib/components.tsx#L157-L181
// Extended: PDF links in UC Volumes open in the in-page preview panel.
const DefaultAnchor: ComponentType<AnchorHTMLAttributes<HTMLAnchorElement>> = (
  props,
) => {
  const isIncomplete = props.href === 'streamdown:incomplete-link';
  const isFootnoteLink = props.href?.startsWith('#');
  const onFileLinkClick = useFileLinkClickHandler(props.href);

  return (
    <a
      className={cn(
        'wrap-anywhere font-medium text-primary underline',
        props.className,
      )}
      data-incomplete={isIncomplete}
      data-streamdown="link"
      href={props.href}
      {...props}
      {...(isFootnoteLink
        ? {
            target: '_self',
          }
        : {
            target: '_blank',
            rel: 'noopener noreferrer',
          })}
      onClick={(event) => {
        props.onClick?.(event);
        onFileLinkClick?.(event);
      }}
    >
      {props.children}
    </a>
  );
};
