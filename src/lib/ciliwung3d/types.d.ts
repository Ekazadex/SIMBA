declare module '*.bin?url' {
  const src: string;
  export default src;
}

declare module './scene.js' {
  export function buildSceneApp(
    canvas: HTMLCanvasElement,
    terrain: any,
    riverAsset: any,
    nodeData: any,
    environmentData: any
  ): any;
}

declare module './navigation.js' {
  export function createCameraNavigator(params: { camera: any; controls: any; now?: () => number }): {
    flyTo: (position: { x: number; y: number; z: number }, options?: { distance?: number; durationMs?: number; targetHeight?: number; direction?: { x: number; y: number; z: number } }) => void;
    update: () => boolean;
    readonly flying: boolean;
  };
}
