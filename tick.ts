export type TickStageName = string;

export interface TickContext {
  readonly tick: number;
}

export interface TickStage<TContext extends TickContext = TickContext> {
  readonly name: TickStageName;
  readonly run: (context: TContext) => void;
}

export interface TickStageResult {
  readonly tick: number;
  readonly stageNames: readonly TickStageName[];
}

export class TickStageRunner<TContext extends TickContext = TickContext> {
  private readonly stages: readonly TickStage<TContext>[];

  constructor(stages: readonly TickStage<TContext>[]) {
    this.stages = stages.map((stage) => ({ ...stage }));
  }

  get stageNames(): readonly TickStageName[] {
    return this.stages.map((stage) => stage.name);
  }

  run(context: TContext): TickStageResult {
    const stageNames: TickStageName[] = [];

    for (const stage of this.stages) {
      stage.run(context);
      stageNames.push(stage.name);
    }

    return {
      tick: context.tick,
      stageNames
    };
  }
}

export function createTickStageRunner<TContext extends TickContext>(
  stages: readonly TickStage<TContext>[]
): TickStageRunner<TContext> {
  return new TickStageRunner(stages);
}
