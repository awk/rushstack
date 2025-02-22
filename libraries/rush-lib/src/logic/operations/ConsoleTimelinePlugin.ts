// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { ITerminal } from '@rushstack/node-core-library';
import { PrintUtilities } from '@rushstack/terminal';
import colors from 'colors/safe';
import { IPhase } from '../../api/CommandLineConfiguration';
import {
  ICreateOperationsContext,
  IPhasedCommandPlugin,
  PhasedCommandHooks
} from '../../pluginFramework/PhasedCommandHooks';
import { IExecutionResult } from './IOperationExecutionResult';
import { OperationStatus } from './OperationStatus';

const PLUGIN_NAME: 'ConsoleTimelinePlugin' = 'ConsoleTimelinePlugin';

/* Sample output:
==============================================================================================================================
          @rushstack/tree-pattern (build) ###########-------------------------------------------------------------------- 3.3s
          @rushstack/eslint-patch (build) ########----------------------------------------------------------------------- 2.2s
           @rushstack/eslint-patch (test) -------%----------------------------------------------------------------------- 0.0s
@rushstack/eslint-plugin-security (build) ----------########################--------------------------------------------- 6.8s
@rushstack/eslint-plugin-packlets (build) ----------############################----------------------------------------- 8.1s
         @rushstack/eslint-plugin (build) ----------##############################--------------------------------------- 8.7s
           @rushstack/tree-pattern (test) ----------#####---------------------------------------------------------------- 1.2s
 @rushstack/eslint-plugin-security (test) ---------------------------------############---------------------------------- 3.3s
 @rushstack/eslint-plugin-packlets (test) -------------------------------------#####------------------------------------- 1.1s
         @rushstack/eslint-config (build) ---------------------------------------%--------------------------------------- 0.0s
          @rushstack/eslint-plugin (test) ---------------------------------------#############--------------------------- 3.8s
          @rushstack/eslint-config (test) ---------------------------------------%--------------------------------------- 0.0s
     @rushstack/node-core-library (build) ---------------------------------------################################-------- 9.5s
      @rushstack/node-core-library (test) ----------------------------------------------------------------------######### 2.2s
==============================================================================================================================
LEGEND:                                                                                                      Total Work: 50.3s
  [#] Success  [!] Failed/warnings  [%] Skipped/cached/no-op                                                 Wall Clock: 23.7s
                                                                                                       Max Parallelism Used: 5
                                                                                                     Avg Parallelism Used: 2.1
BY PHASE:
      _phase:build 38.6s
       _phase:test 11.7s
*/

/**
 * Phased command plugin that emits a timeline to the console.
 */
export class ConsoleTimelinePlugin implements IPhasedCommandPlugin {
  private readonly _terminal: ITerminal;

  public constructor(terminal: ITerminal) {
    this._terminal = terminal;
  }

  public apply(hooks: PhasedCommandHooks): void {
    hooks.afterExecuteOperations.tap(
      PLUGIN_NAME,
      (result: IExecutionResult, context: ICreateOperationsContext): void => {
        _printTimeline(this._terminal, result);
      }
    );
  }
}

/**
 * Timeline - a wider column width for printing the timeline summary
 */
const TIMELINE_WIDTH: number = 109;

/**
 * Timeline - symbols representing each operation status
 */
const TIMELINE_CHART_SYMBOLS: Record<OperationStatus, string> = {
  [OperationStatus.Ready]: '?',
  [OperationStatus.Executing]: '?',
  [OperationStatus.Success]: '#',
  [OperationStatus.SuccessWithWarning]: '!',
  [OperationStatus.Failure]: '!',
  [OperationStatus.Blocked]: '.',
  [OperationStatus.Skipped]: '%',
  [OperationStatus.FromCache]: '%',
  [OperationStatus.NoOp]: '%'
};

/**
 * Timeline - colorizer for each operation status
 */
const TIMELINE_CHART_COLORIZER: Record<OperationStatus, (string: string) => string> = {
  [OperationStatus.Ready]: colors.yellow,
  [OperationStatus.Executing]: colors.yellow,
  [OperationStatus.Success]: colors.green,
  [OperationStatus.SuccessWithWarning]: colors.yellow,
  [OperationStatus.Failure]: colors.red,
  [OperationStatus.Blocked]: colors.red,
  [OperationStatus.Skipped]: colors.green,
  [OperationStatus.FromCache]: colors.green,
  [OperationStatus.NoOp]: colors.gray
};

interface ITimelineRecord {
  startTime: number;
  endTime: number;
  durationString: string;
  name: string;
  status: OperationStatus;
}
/**
 * Print a more detailed timeline and analysis of CPU usage for the build.
 * @internal
 */
export function _printTimeline(terminal: ITerminal, result: IExecutionResult): void {
  //
  // Gather the operation records we'll be displaying. Do some inline max()
  // finding to reduce the number of times we need to loop through operations.
  //

  const durationByPhase: Map<IPhase, number> = new Map();

  const data: ITimelineRecord[] = [];
  let longestNameLength: number = 0;
  let longestDurationLength: number = 0;
  let allStart: number = Infinity;
  let allEnd: number = -Infinity;
  let workDuration: number = 0;

  for (const [operation, operationResult] of result.operationResults) {
    if (operation.runner?.silent) {
      continue;
    }

    const { stopwatch } = operationResult;

    const { startTime, endTime } = stopwatch;

    if (startTime && endTime) {
      const nameLength: number = operation.name?.length || 0;
      if (nameLength > longestNameLength) {
        longestNameLength = nameLength;
      }

      const { duration } = stopwatch;
      const durationString: string = duration.toFixed(1);
      const durationLength: number = durationString.length;
      if (durationLength > longestDurationLength) {
        longestDurationLength = durationLength;
      }

      if (endTime > allEnd) {
        allEnd = endTime;
      }
      if (startTime < allStart) {
        allStart = startTime;
      }
      workDuration += duration;

      const { associatedPhase } = operation;

      if (associatedPhase) {
        durationByPhase.set(associatedPhase, (durationByPhase.get(associatedPhase) || 0) + duration);
      }

      data.push({
        startTime,
        endTime,
        durationString,
        name: operation.name!,
        status: operationResult.status
      });
    }
  }

  data.sort((a, b) => a.startTime - b.startTime);

  //
  // Determine timing for all tasks (wall clock and execution times)
  //

  const allDuration: number = allEnd - allStart;
  const allDurationSeconds: number = allDuration / 1000;

  //
  // Do some calculations to determine what size timeline chart we need.
  //

  const maxWidth: number = PrintUtilities.getConsoleWidth() || TIMELINE_WIDTH;
  const chartWidth: number = maxWidth - longestNameLength - longestDurationLength - 4;
  //
  // Loop through all operations, assembling some statistics about operations and
  // phases, if applicable.
  //

  const busyCpus: number[] = [];
  function getOpenCPU(time: number): number {
    const len: number = busyCpus.length;
    for (let i: number = 0; i < len; i++) {
      if (busyCpus[i] <= time) {
        return i;
      }
    }
    return len;
  }

  // Start with a newline
  terminal.writeLine('');
  terminal.writeLine('='.repeat(maxWidth));

  for (const { startTime, endTime, durationString, name, status } of data) {
    // Track busy CPUs
    const openCpu: number = getOpenCPU(startTime);
    busyCpus[openCpu] = endTime;

    // Build timeline chart
    const startIdx: number = Math.floor(((startTime - allStart) * chartWidth) / allDuration);
    const endIdx: number = Math.floor(((endTime - allStart) * chartWidth) / allDuration);
    const length: number = endIdx - startIdx + 1;

    const chart: string =
      colors.gray('-'.repeat(startIdx)) +
      TIMELINE_CHART_COLORIZER[status](TIMELINE_CHART_SYMBOLS[status].repeat(length)) +
      colors.gray('-'.repeat(chartWidth - endIdx));
    terminal.writeLine(
      `${colors.cyan(name.padStart(longestNameLength))} ${chart} ${colors.white(
        durationString.padStart(longestDurationLength) + 's'
      )}`
    );
  }

  terminal.writeLine('='.repeat(maxWidth));

  //
  // Format legend and summary areas
  //

  const usedCpus: number = busyCpus.length;

  const legend: string[] = ['LEGEND:', '  [#] Success  [!] Failed/warnings  [%] Skipped/cached/no-op'];

  const summary: string[] = [
    `Total Work: ${workDuration.toFixed(1)}s`,
    `Wall Clock: ${allDurationSeconds.toFixed(1)}s`
  ];

  terminal.writeLine(legend[0] + summary[0].padStart(maxWidth - legend[0].length));
  terminal.writeLine(legend[1] + summary[1].padStart(maxWidth - legend[1].length));
  terminal.writeLine(`Max Parallelism Used: ${usedCpus}`.padStart(maxWidth));
  terminal.writeLine(
    `Avg Parallelism Used: ${(workDuration / allDurationSeconds).toFixed(1)}`.padStart(maxWidth)
  );

  //
  // Include time-by-phase, if phases are enabled
  //

  if (durationByPhase.size > 0) {
    terminal.writeLine('BY PHASE:');

    let maxPhaseName: number = 16;
    for (const phase of durationByPhase.keys()) {
      const len: number = phase.name.length;
      if (len > maxPhaseName) {
        maxPhaseName = len;
      }
    }

    for (const [phase, duration] of durationByPhase.entries()) {
      terminal.writeLine(`  ${colors.cyan(phase.name.padStart(maxPhaseName))} ${duration.toFixed(1)}s`);
    }
  }

  terminal.writeLine('');
}
