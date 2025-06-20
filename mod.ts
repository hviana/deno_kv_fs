/*
Created by: Henrique Emanoel Viana
Githu: https://github.com/hviana
Page: https://sites.google.com/view/henriqueviana
cel: +55 (41) 99999-4664
*/

import { delay } from "./deps.ts";

interface SaveOptions {
  path: string[];
  content: ReadableStream | Uint8Array | string;
  metadata?: Record<string, any>;
  chunksPerSecond?: number;
  clientId?: string | number;
  validateAccess?: (path: string[]) => Promise<boolean> | boolean;
  maxClientIdConcurrentReqs?: number;
  maxFileSizeBytes?: number;
  allowedExtensions?: string[];
}

interface ReadOptions {
  path: string[];
  chunksPerSecond?: number;
  maxDirEntriesPerSecond?: number;
  clientId?: string | number;
  validateAccess?: (path: string[]) => Promise<boolean> | boolean;
  maxClientIdConcurrentReqs?: number;
  pagination?: boolean;
  cursor?: string;
}
const defaultSaveOptions = {
  chunksPerSecond: Number.MAX_SAFE_INTEGER,
  maxFileSizeBytes: Number.MAX_SAFE_INTEGER,
  allowedExtensions: [],
  clientId: undefined,
  validateAccess: (path: string[]) => true,
  maxClientIdConcurrentReqs: Number.MAX_SAFE_INTEGER,
};
const defaultReadOptions = {
  chunksPerSecond: Number.MAX_SAFE_INTEGER,
  maxDirEntriesPerSecond: Number.MAX_SAFE_INTEGER,
  clientId: undefined,
  validateAccess: (path: string[]) => true,
  maxClientIdConcurrentReqs: Number.MAX_SAFE_INTEGER,
};
interface SaveResult {
  flags: string[];
  size: number;
}
interface File {
  path: string[];
  flags: string[];
  size: number;
  content?: ReadableStream<Uint8Array>;
  URIComponent?: string;
  metadata?: Record<string, any>;
}
interface DirList {
  files: (File | FileStatus)[];
  size: number;
  cursor?: string;
}
interface FileStatus {
  URIComponent: string;
  path: string[];
  progress: number;
  status: "saving" | "deleting" | "error";
  msg?: string;
}
class DenoKvFs {
  #enc = new TextEncoder();
  static _dec: TextDecoder = new TextDecoder();
  #chunkSize: number = 65536;
  #maxPageSize: number = 1000;
  #oneSecondDelayMillis: number = 1000;
  #toChunks(arr: Uint8Array) {
    return Array.from(
      { length: Math.ceil(arr.length / this.#chunkSize) },
      (v: any, i: number) =>
        arr.slice(i * this.#chunkSize, i * this.#chunkSize + this.#chunkSize),
    );
  }
  #kv: Deno.Kv | undefined;
  #clientsReqsMap: { [key: string | number]: number } = {};
  #savingFiles: { [key: string]: number } = {};
  #deletingFiles: { [key: string]: number } = {};
  onFileProgress: (status: FileStatus) => void;

  constructor(kv: Deno.Kv | undefined = undefined) {
    this.#kv = kv;
    this.#deleteUnresolvedFiles(); //without await, it is necessary to run concurrently
    this.onFileProgress = (status: FileStatus) => undefined;
  }
  static async readStream(stream: ReadableStream): Promise<Uint8Array> {
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  static async readStreamAsString(stream: ReadableStream): Promise<string> {
    return DenoKvFs._dec.decode(
      new Uint8Array(await new Response(stream).arrayBuffer()),
    );
  }

  getClientReqs(clientId: string | number): number {
    return this.#clientsReqsMap[clientId] || 0;
  }
  getAllFilesStatuses(): FileStatus[] {
    let res: FileStatus[] = [];
    for (const URIComponent in this.#savingFiles) {
      res.push({
        URIComponent: URIComponent,
        path: this.URIComponentToPath(URIComponent),
        progress: this.#savingFiles[URIComponent],
        status: "saving",
      });
    }
    for (const URIComponent in this.#deletingFiles) {
      res.push({
        URIComponent: URIComponent,
        path: this.URIComponentToPath(URIComponent),
        progress: this.#deletingFiles[URIComponent],
        status: "deleting",
      });
    }
    return res;
  }
  //{cursor: "xxx", limit:1000} must be the last search parameter in the list.
  static async *pagedListIterator(
    listParams: any[],
    kv: Deno.Kv,
  ): AsyncGenerator<any> {
    //@ts-ignore
    let entries = kv.list(...listParams);
    let finished: boolean = false;
    let count = 0;
    while (!finished) {
      const { value, done } = await entries.next();
      finished = done as boolean;
      if (finished) {
        if (entries.cursor) {
          if (listParams.length < 2) {
            listParams.push({ cursor: entries.cursor, limit: 1000 });
          } else {
            listParams[listParams.length - 1]["cursor"] = entries.cursor;
          }
          //@ts-ignore
          entries = kv.list(...listParams);
          finished = false;
        }
      }
      if (value) {
        count++;
        if (count == listParams[listParams.length - 1]["limit"]) {
          count = 0;
          //@ts-ignore
          value.cursor = entries.cursor;
        }
        yield value;
      }
    }
  }
  pathToURIComponent(path: string[]): string {
    const urlParts: string[] = [];
    for (const p of path) {
      urlParts.push(encodeURIComponent(p));
    }
    return urlParts.join("/");
  }
  URIComponentToPath(uri: string): string[] {
    const uriParts: string[] = uri.split("/");
    const path: string[] = [];
    for (const p of uriParts) {
      path.push(decodeURIComponent(p));
    }
    return path;
  }
  async save(options: SaveOptions): Promise<FileStatus | File> {
    const uri = this.pathToURIComponent(options.path);
    const status = this.#fileStatus(uri);
    if (status) {
      return status;
    }

    if (options.metadata) {
      const metaSize =
        new TextEncoder().encode(JSON.stringify(options.metadata)).length;
      if (metaSize > 60 * 1024) {
        const status: FileStatus = {
          URIComponent: uri,
          path: options.path,
          status: "error",
          progress: 0,
          msg: "Metadata exceeds 60KB limit",
        };
        this.onFileProgress(status);
        return status;
      }
    }

    options = { ...defaultSaveOptions, ...options };
    if (options.validateAccess) {
      if (!(await options.validateAccess!(options.path))) {
        const status: FileStatus = {
          URIComponent: uri,
          path: options.path,
          status: "error",
          progress: 0,
          msg: "Forbidden",
        };
        this.onFileProgress(status);
        return status;
      }
    }

    if (options.allowedExtensions!.length > 0) {
      const fileExt = options.path[options.path.length - 1].split(".").pop();
      if (!options.allowedExtensions!.includes(fileExt!)) {
        const status: FileStatus = {
          URIComponent: uri,
          path: options.path,
          status: "error",
          progress: 0,
          msg: `The file extension is not allowed (${fileExt} in ${
            options.path[options.path.length - 1]
          }), allowed extensions: ${options.allowedExtensions!.join(", ")}. `,
        };
        this.onFileProgress(status);
        return status;
      }
    }
    await this.#initKv();
    await this.#startSaving(options);
    if (
      this.getClientReqs(options.clientId!) > options.maxClientIdConcurrentReqs!
    ) {
      await this.#endSaving(options);
      const status: FileStatus = {
        URIComponent: uri,
        path: options.path,
        status: "error",
        progress: 0,
        msg: `You can only make a maximum of ${options
          .maxClientIdConcurrentReqs!} concurrent requests.`,
      };
      this.onFileProgress(status);
      return status;
    }
    try {
      let savingRes: any = {};
      if (
        typeof options.content === "string" || options.content instanceof String
      ) {
        options.content = this.#enc.encode(options.content as string);
      }
      if (options.content instanceof Uint8Array) {
        savingRes = await this.#saveFromUint8Array(
          uri,
          options,
        );
      } else {
        savingRes = await this.#saveFromReader(
          uri,
          options,
        );
      }
      const file = {
        path: options.path,
        URIComponent: uri,
        metadata: options.metadata || {},
        ...savingRes,
      };
      await this.#kv!.set(["deno_kv_fs", "files", ...options.path], file);
      await this.#endSaving(options);
      return file;
    } catch (e: any) {
      try {
        await this.#endSaving(options, false);
        this.delete(options); //concurrent
      } catch {
        //
      }
      console.log(e);
      const status: FileStatus = {
        URIComponent: uri,
        path: options.path,
        status: "error",
        progress: 0,
        msg: (e.message || JSON.stringify(e)),
      };
      this.onFileProgress(status);
      return status;
    }
  }
  async read(options: ReadOptions): Promise<File | FileStatus | null> {
    const uri = this.pathToURIComponent(options.path);
    const status = this.#fileStatus(uri);
    if (status) {
      return status;
    }
    options = { ...defaultReadOptions, ...options };
    if (options.validateAccess) {
      if (!(await options.validateAccess!(options.path))) {
        const status: FileStatus = {
          URIComponent: uri,
          path: options.path,
          status: "error",
          progress: 0,
          msg: "Forbidden",
        };
        this.onFileProgress(status);
        return status;
      }
    }
    await this.#initKv();
    const file = (await this.#kv!.get(["deno_kv_fs", "files", ...options.path]))
      .value as File | null;
    if (file) {
      this.#contentData(
        file,
        options,
      );
    }
    return file;
  }
  async readDir(options: ReadOptions): Promise<DirList> {
    options = { ...defaultReadOptions, ...options };
    if (options.validateAccess) {
      if (!(await options.validateAccess!(options.path))) {
        const status: FileStatus = {
          URIComponent: this.pathToURIComponent(options.path),
          path: options.path,
          status: "error",
          progress: 0,
          msg: "Forbidden",
        };
        this.onFileProgress(status);
        return { files: [status], size: 0 };
      }
    }
    await this.#initKv();
    const listParams: any[] = [{
      prefix: ["deno_kv_fs", "files", ...options.path],
    }, {
      limit: this.#maxPageSize,
    }];
    if (options.cursor) {
      listParams[listParams.length - 1]["cursor"] = options.cursor;
    }
    let filesCount = 0;
    let time = Date.now();
    const res: DirList = { files: [], size: 0 };
    for await (const f of DenoKvFs.pagedListIterator(listParams, this.#kv!)) {
      if ((Date.now() - time) < this.#oneSecondDelayMillis) {
        filesCount++;
        if (filesCount > options.maxDirEntriesPerSecond!) {
          await delay(this.#oneSecondDelayMillis);
          filesCount = 0;
          time = Date.now();
        }
      } else {
        filesCount = 0;
        time = Date.now();
      }
      const filePath = f.key.slice(2) as string[];
      const uri = this.pathToURIComponent(filePath);
      const status = this.#fileStatus(uri);
      if (status) {
        if (status.status == "saving" && status.progress) {
          res.size += status.progress;
        }
        res.files.push(status);
      } else {
        res.size += (f.value as File).size;
        this.#contentData(
          f.value as File,
          {
            ...options,
            ...{ path: filePath },
          },
        );
        res.files.push(f.value as File);
      }
      if (res.files.length == this.#maxPageSize) {
        if (options.pagination) {
          //@ts-ignore
          if (f.cursor) { //@ts-ignore
            res["cursor"] = f.cursor;
            break;
          }
        }
      }
    }
    return res;
  }
  async setMetadata(
    path: string[],
    metadata: Record<string, any>,
  ): Promise<void> {
    const metaSize = new TextEncoder().encode(JSON.stringify(metadata)).length;
    if (metaSize > 60 * 1024) {
      throw new Error("Metadata exceeds 60KB limit");
    }

    await this.#initKv();
    const file = (await this.#kv!.get(["deno_kv_fs", "files", ...path]))
      .value as File;
    if (file) {
      file.metadata = metadata;
      await this.#kv!.set(["deno_kv_fs", "files", ...path], file);
    }
  }

  async getMetadata(path: string[]): Promise<Record<string, any> | undefined> {
    await this.#initKv();
    const file = (await this.#kv!.get(["deno_kv_fs", "files", ...path]))
      .value as File;
    return file?.metadata;
  }
  async delete(options: ReadOptions): Promise<void | FileStatus> {
    const uri = this.pathToURIComponent(options.path);
    const status = this.#fileStatus(uri);
    if (status) {
      return status;
    }
    options = { ...defaultReadOptions, ...options };
    if (options.validateAccess) {
      if (!(await options.validateAccess!(options.path))) {
        const status: FileStatus = {
          URIComponent: uri,
          path: options.path,
          status: "error",
          progress: 0,
          msg: "Forbidden",
        };
        this.onFileProgress(status);
        return status;
      }
    }
    try {
      await this.#initKv();
      await this.#startDeleting(options);
      if (
        this.getClientReqs(options.clientId!) >
          options.maxClientIdConcurrentReqs!
      ) {
        await this.#endDeleting(options);
        const status: FileStatus = {
          URIComponent: uri,
          path: options.path,
          status: "error",
          progress: 0,
          msg: `You can only make a maximum of ${options
            .maxClientIdConcurrentReqs!} concurrent requests.`,
        };
        this.onFileProgress(status);
        return status;
      }
      await this.#kv!.delete(["deno_kv_fs", "files", ...options.path]);
      await this.#deleteChunks(options);
      await this.#endDeleting(options);
    } catch (e: any) {
      try {
        await this.#endDeleting(options, false);
      } catch {
        //
      }
      console.log(e);
      const status: FileStatus = {
        URIComponent: uri,
        path: options.path,
        status: "error",
        progress: 0,
        msg: (e.message || JSON.stringify(e)),
      };
      this.onFileProgress(status);
      return status;
    }
  }
  async deleteDir(options: ReadOptions): Promise<FileStatus[]> {
    options = { ...defaultReadOptions, ...options };
    if (options.validateAccess) {
      if (!(await options.validateAccess!(options.path))) {
        const status: FileStatus = {
          URIComponent: this.pathToURIComponent(options.path),
          path: options.path,
          status: "error",
          progress: 0,
          msg: "Forbidden",
        };
        this.onFileProgress(status);
        return [status];
      }
    }
    await this.#initKv();
    const listParams = [{
      prefix: ["deno_kv_fs", "files", ...options.path],
    }, {
      limit: this.#maxPageSize,
    }];
    let res: FileStatus[] = [];
    let filesCount = 0;
    let time = Date.now();
    for await (
      const entry of DenoKvFs.pagedListIterator(listParams, this.#kv!)
    ) {
      if ((Date.now() - time) < this.#oneSecondDelayMillis) {
        filesCount++;
        if (filesCount > options.maxDirEntriesPerSecond!) {
          await delay(this.#oneSecondDelayMillis);
          filesCount = 0;
          time = Date.now();
        }
      } else {
        filesCount = 0;
        time = Date.now();
      }
      const status = await this.delete({
        ...options,
        ...{ path: entry.key.slice(2) as string[] },
      });
      if (status) {
        res.push(
          status,
        );
      }
    }
    return res;
  }
  async #initKv(): Promise<void> {
    if (!this.#kv) {
      this.#kv = await Deno.openKv();
    }
  }
  async #deleteUnresolvedFiles(): Promise<void> {
    await this.#initKv();
    const listParamsSaving = [{
      prefix: ["deno_kv_fs", "unresolved"],
    }, {
      limit: this.#maxPageSize,
    }];
    for await (
      const f of DenoKvFs.pagedListIterator(listParamsSaving, this.#kv!)
    ) {
      this.delete(f.value as ReadOptions); //concurrent
    }
  }
  #fileIsSaving(URIComponent: string): boolean {
    return (URIComponent in this.#savingFiles);
  }
  #fileIsDeleting(URIComponent: string): boolean {
    return (URIComponent in this.#deletingFiles);
  }
  #fileStatus(URIComponent: string): FileStatus | undefined {
    if (this.#fileIsSaving(URIComponent)) {
      return {
        URIComponent: URIComponent,
        path: this.URIComponentToPath(URIComponent),
        progress: this.#savingFiles[URIComponent],
        status: "saving",
      };
    } else if (this.#fileIsDeleting(URIComponent)) {
      return {
        URIComponent: URIComponent,
        path: this.URIComponentToPath(URIComponent),
        progress: this.#deletingFiles[URIComponent],
        status: "deleting",
      };
    } else {
      return undefined;
    }
  }
  _incrementClientIdReq(clientId: any): void {
    if (clientId) {
      if (!this.#clientsReqsMap[clientId]) {
        this.#clientsReqsMap[clientId] = 0;
      }
      this.#clientsReqsMap[clientId]++;
    }
  }
  _decrementClientIdReq(clientId: any): void {
    if (clientId) {
      if (this.#clientsReqsMap[clientId]) {
        this.#clientsReqsMap[clientId]--;
        if (this.#clientsReqsMap[clientId] < 1) {
          delete this.#clientsReqsMap[clientId];
        }
      }
    }
  }
  async #startSaving(params: SaveOptions): Promise<void> {
    this._incrementClientIdReq(params.clientId);
    const URIComponent = this.pathToURIComponent(params.path);
    this.#savingFiles[URIComponent] = 0;
    await this.#kv!.set(
      ["deno_kv_fs", "unresolved", URIComponent],
      { ...params, ...{ content: undefined, validateAccess: undefined } },
    );
  }
  async #endSaving(
    params: SaveOptions,
    resolved: boolean = true,
  ): Promise<void> {
    const URIComponent = this.pathToURIComponent(params.path);
    if (resolved) {
      await this.#kv!.delete(
        ["deno_kv_fs", "unresolved", URIComponent],
      );
    }
    delete this.#savingFiles[URIComponent];
    this._decrementClientIdReq(params.clientId);
  }
  async #startDeleting(params: ReadOptions): Promise<void> {
    this._incrementClientIdReq(params.clientId);
    const URIComponent = this.pathToURIComponent(params.path);
    this.#deletingFiles[URIComponent] = 0;
    await this.#kv!.set(
      ["deno_kv_fs", "unresolved", URIComponent],
      { ...params, ...{ content: undefined, validateAccess: undefined } },
    );
  }
  async #endDeleting(
    params: ReadOptions,
    resolved: boolean = true,
  ): Promise<void> {
    const URIComponent = this.pathToURIComponent(params.path);
    if (resolved) {
      await this.#kv!.delete(
        ["deno_kv_fs", "unresolved", URIComponent],
      );
    }
    delete this.#deletingFiles[URIComponent];
    this._decrementClientIdReq(params.clientId);
  }
  async #retract(params: SaveOptions, nextChunkIndex: number): Promise<void> {
    const uri = this.pathToURIComponent(params.path);
    const listParams: any = [
      {
        start: ["deno_kv_fs", "chunks", uri, nextChunkIndex],
        end: ["deno_kv_fs", "chunks", uri, Number.MAX_SAFE_INTEGER],
      },
      {
        limit: this.#maxPageSize,
      },
    ];
    let time = Date.now();
    let chunksCount = 0;
    let totalBytes = 0;
    for await (
      const value of DenoKvFs.pagedListIterator(listParams, this.#kv!)
    ) {
      await this.#kv!.delete(value.key);
      totalBytes += (value.value as Uint8Array).length;
      if ((Date.now() - time) < this.#oneSecondDelayMillis) {
        chunksCount++;
        if (chunksCount > params.chunksPerSecond!) {
          await delay(this.#oneSecondDelayMillis);
          const status = this.#fileStatus(uri)!;
          status["msg"] =
            `Deleting previous data, ${totalBytes} bytes deleted.`;
          this.onFileProgress(status);
          chunksCount = 0;
          time = Date.now();
        }
      } else {
        chunksCount = 0;
        time = Date.now();
        const status = this.#fileStatus(uri)!;
        status["msg"] = `Deleting previous data, ${totalBytes} bytes deleted.`;
        this.onFileProgress(status);
      }
    }
  }
  async #deleteChunks(params: ReadOptions): Promise<void> {
    const uri = this.pathToURIComponent(params.path);
    const listParams: any = [
      {
        prefix: ["deno_kv_fs", "chunks", uri],
      },
      {
        limit: this.#maxPageSize,
      },
    ];
    let time = Date.now();
    let chunksCount = 0;
    for await (
      const value of DenoKvFs.pagedListIterator(listParams, this.#kv!)
    ) {
      await this.#kv!.delete(value.key);
      this.#deletingFiles[uri] += (value.value as Uint8Array).length;
      if ((Date.now() - time) < this.#oneSecondDelayMillis) {
        chunksCount++;
        if (chunksCount > params.chunksPerSecond!) {
          await delay(this.#oneSecondDelayMillis);
          this.onFileProgress(this.#fileStatus(uri)!);
          chunksCount = 0;
          time = Date.now();
        }
      } else {
        chunksCount = 0;
        time = Date.now();
        this.onFileProgress(this.#fileStatus(uri)!);
      }
    }
    this.onFileProgress(this.#fileStatus(uri)!);
  }
  #contentData(
    fileData: File,
    options: ReadOptions,
  ): void {
    fileData["URIComponent"] = this.pathToURIComponent(options.path);
    fileData.content = this.#contentToStream(
      fileData["URIComponent"],
      options,
    );
  }
  #contentToStream(
    URIComponent: string,
    options: ReadOptions,
  ): ReadableStream<Uint8Array> {
    const listParams = [{
      prefix: ["deno_kv_fs", "chunks", URIComponent],
    }, {
      limit: this.#maxPageSize,
    }];
    const entries = DenoKvFs.pagedListIterator(listParams, this.#kv!);
    let time = Date.now();
    let chunksCount = 0;
    const kvFs: DenoKvFs = this;
    let started = false;
    return new ReadableStream({
      type: "bytes",
      async pull(controller) {
        try {
          if (!started) {
            started = true;
            kvFs._incrementClientIdReq(options.clientId);
            if (
              kvFs.getClientReqs(options.clientId!) >
                options.maxClientIdConcurrentReqs!
            ) {
              throw new Error(
                `You can only make a maximum of ${options
                  .maxClientIdConcurrentReqs!} concurrent requests.`,
              );
            }
          }
          const { value, done } = await entries.next();
          if (value) {
            controller.enqueue(value.value as Uint8Array);
          }
          if (done) {
            kvFs._decrementClientIdReq(options.clientId);
            controller.close();
            if (controller.byobRequest) {
              controller.byobRequest.respond(0);
            }
          }
          if ((Date.now() - time) < kvFs.#oneSecondDelayMillis) {
            chunksCount++;
            if (chunksCount > options.chunksPerSecond!) {
              await delay(kvFs.#oneSecondDelayMillis);
              chunksCount = 0;
              time = Date.now();
            }
          } else {
            chunksCount = 0;
            time = Date.now();
          }
        } catch (e) {
          kvFs._decrementClientIdReq(options.clientId);
          controller.error(e);
        }
      },
    });
  }
  async #getChunkIter(
    reader: ReadableStreamBYOBReader,
  ): Promise<[Uint8Array, boolean]> {
    let chunkBuffer = new ArrayBuffer(this.#chunkSize);
    let offset = 0;
    let finished = false;
    while (offset < chunkBuffer.byteLength) {
      const { done, value } = await reader.read(
        new Uint8Array(chunkBuffer, offset, chunkBuffer.byteLength - offset),
      );
      if (value) {
        chunkBuffer = value.buffer;
        offset += value.byteLength;
      }
      if (done) {
        finished = true;
        break;
      }
    }
    if (offset < this.#chunkSize) {
      chunkBuffer = chunkBuffer.slice(0, -(this.#chunkSize - offset));
    }
    return [new Uint8Array(chunkBuffer), finished];
  }
  #createByteStream(
    reader: ReadableStreamDefaultReader,
  ): ReadableStream<Uint8Array> {
    return new ReadableStream({
      type: "bytes",
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (value) {
            controller.enqueue(value);
          }
          if (done) {
            controller.close();
            if (controller.byobRequest) {
              controller.byobRequest.respond(0);
            }
          }
        } catch (e) {
          controller.error(e);
        }
      },
    });
  }
  async #saveFromReader(
    URIComponent: string,
    params: SaveOptions,
  ): Promise<SaveResult> {
    let sizeBytes = 0;
    let reader: ReadableStreamReader<any>;
    try {
      reader = (params.content as ReadableStream).getReader({
        mode: "byob",
      });
    } catch {
      params.content = this.#createByteStream(
        (params.content as ReadableStream).getReader(),
      );
      reader = (params.content as ReadableStream).getReader({
        mode: "byob",
      });
    }

    let totalCount = 0;
    let time = Date.now();
    let chunkIter = [new Uint8Array(), false] as [Uint8Array, boolean];
    let chunksCount = 0;
    const flags: string[] = [];
    while (!chunkIter[1]) {
      chunkIter = await this.#getChunkIter(reader);
      const chunk = chunkIter[0];
      if (sizeBytes > params.maxFileSizeBytes!) {
        flags.push("incomplete");
        break;
      }
      totalCount++;
      await this.#kv!.set(
        ["deno_kv_fs", "chunks", URIComponent, totalCount],
        chunk,
      );
      sizeBytes += chunk.length;
      this.#savingFiles[URIComponent] = sizeBytes;
      if ((Date.now() - time) < this.#oneSecondDelayMillis) {
        chunksCount++;
        if (chunksCount > params.chunksPerSecond!) {
          await delay(this.#oneSecondDelayMillis);
          this.onFileProgress(this.#fileStatus(URIComponent)!);
          chunksCount = 0;
          time = Date.now();
        }
      } else {
        chunksCount = 0;
        time = Date.now();
        this.onFileProgress(this.#fileStatus(URIComponent)!);
      }
    }
    await this.#retract(params, totalCount + 1);
    if (flags.includes("incomplete")) {
      this.onFileProgress(
        <FileStatus> {
          URIComponent: URIComponent,
          path: params.path,
          status: "error",
          msg:
            `The file exceeded the maximum allowed of ${params.maxFileSizeBytes} bytes.`,
        },
      );
    } else {
      this.onFileProgress(this.#fileStatus(URIComponent)!);
    }
    return {
      flags: flags,
      size: sizeBytes,
    };
  }
  async #saveFromUint8Array(
    URIComponent: string,
    params: SaveOptions,
  ): Promise<SaveResult> {
    const chunks = this.#toChunks(params.content as Uint8Array);
    let sizeBytes = 0;
    let totalCount = 0;
    let time = Date.now();
    let chunksCount = 0;
    let flags: any = [];
    for (const chunk of chunks) {
      if (sizeBytes > params.maxFileSizeBytes!) {
        flags.push("incomplete");
        break;
      }
      totalCount++;
      await this.#kv!.set(
        ["deno_kv_fs", "chunks", URIComponent, totalCount],
        chunk,
      );
      sizeBytes += chunk.length;
      this.#savingFiles[URIComponent] = sizeBytes;
      if ((Date.now() - time) < this.#oneSecondDelayMillis) {
        chunksCount++;
        if (chunksCount > params.chunksPerSecond!) {
          await delay(this.#oneSecondDelayMillis);
          this.onFileProgress(this.#fileStatus(URIComponent)!);
          chunksCount = 0;
          time = Date.now();
        }
      } else {
        chunksCount = 0;
        time = Date.now();
        this.onFileProgress(this.#fileStatus(URIComponent)!);
      }
    }
    await this.#retract(params, totalCount + 1);
    if (flags.includes("incomplete")) {
      this.onFileProgress(
        <FileStatus> {
          URIComponent: URIComponent,
          path: params.path,
          status: "error",
          msg:
            `The file exceeded the maximum allowed of ${params.maxFileSizeBytes} bytes.`,
        },
      );
    } else {
      this.onFileProgress(this.#fileStatus(URIComponent)!);
    }
    return {
      flags: flags,
      size: sizeBytes,
    };
  }
}

export {
  DenoKvFs,
  type DirList,
  type File,
  type FileStatus,
  type ReadOptions,
  type SaveOptions,
};
