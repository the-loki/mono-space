export interface MonoSpaceApi {
  ping(message: string): Promise<string>
}

declare global {
  interface Window {
    api: MonoSpaceApi
  }
}

export {}
