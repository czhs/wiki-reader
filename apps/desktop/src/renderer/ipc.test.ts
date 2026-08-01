/**
 * What a failure reads like to the person it happens to.
 *
 * `describeError(...).message` is the string the status line and every panel's error state
 * show, so whatever is in it is a sentence the researcher is asked to make sense of. It used
 * to open with the channel name — an internal identifier, and one that still spells the word
 * milestone 5 retired: "question:notebook: notebook not found" on the notebook page itself.
 */
import { describe, expect, it } from 'vitest';
import { IpcCallError, describeError } from './ipc.js';

describe('the message a failed call shows', () => {
  it('[P01] is the main process’s sentence, with no channel name in front of it', () => {
    const failure = new IpcCallError('question:notebook', {
      code: 'NOT_FOUND',
      message: 'notebook not found',
    });

    expect(failure.message).toBe('notebook not found');
    expect(describeError(failure).message).toBe('notebook not found');
    expect(describeError(failure).message).not.toContain('question');
    // Still available to a log or a bug report, which is where a channel name belongs.
    expect(failure.channel).toBe('question:notebook');
    expect(failure.code).toBe('NOT_FOUND');
  });

  it('carries the remedy through, and falls back for a thrown value that is not an error', () => {
    const withRemedy = new IpcCallError('library:getDocument', {
      code: 'INVALID_REQUEST',
      message: 'that file is not in the library',
      remedy: 'Import it from Zotero first.',
    });
    expect(describeError(withRemedy)).toEqual({
      message: 'that file is not in the library',
      remedy: 'Import it from Zotero first.',
    });
    expect(describeError('a bare string')).toEqual({ message: 'a bare string', remedy: null });
  });
});
