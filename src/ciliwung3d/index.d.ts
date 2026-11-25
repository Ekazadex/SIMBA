export interface Ciliwung3DNodeInput {
  id: string;
  name?: string;
  tmaCm?: number | null;
  stageRiseM?: number | null;
  status?: string;
}

export interface Ciliwung3DStationMeta {
  id: string;
  name: string;
  elevationM: number;
  longitude: number;
  latitude: number;
}

export interface Ciliwung3DController {
  stationsMeta: Ciliwung3DStationMeta[];
  selectNodeById: (nodeId: string, options?: { fly?: boolean; immediate?: boolean }) => string | null;
  flyToSea: () => void;
  flyToOverview: () => void;
  resetView: () => void;
  applyNodeLevels: (nodes: Ciliwung3DNodeInput[]) => number[];
  resize: (width?: number, height?: number) => void;
  renderFrame: (elapsedSeconds: number, averageRunoff: number) => void;
  dispose: () => void;
}

export function buildCiliwung3DScene(
  canvas: HTMLCanvasElement,
  options?: {
    mode?: 'hardware' | 'simulation';
    initialNodeId?: string;
  }
): Ciliwung3DController;
