# 🚀 **deno_kv_fs**

> [!IMPORTANT]\
> **Please give a star!** ⭐

---

## 🌟 Introduction

**deno_kv_fs** is a **Deno KV file system**, compatible with **Deno Deploy**. It
saves files in 64KB chunks, allowing you to organize files into directories. You
can control the KB/s rate for saving and reading files, impose rate limits, set
user space limits, and limit concurrent operations—useful for controlling
uploads/downloads. It utilizes the **Web Streams API**.

---

## 📚 **Contents**

- [🚀 Introduction](#-introduction)
- [🔧 How to Use](#-how-to-use)
- [💡 Examples](#-examples)
  - [💾 Saving Data](#-saving-data)
  - [💾 Saving Data Directly](#-saving-data-directly)
  - [📤 Saving Data from a Submitted Form](#-saving-data-from-a-submitted-form)
    - [🌐 In Frontend](#-in-frontend)
  - [📥 Returning Data](#-returning-data)
  - [📥 Returning Data Directly](#-returning-data-directly)
  - [⚙️ Example Function to Control Data Traffic](#%EF%B8%8F-example-function-to-control-data-traffic)
- [📡 Sending File Progress in Real-Time](#-sending-file-progress-in-real-time)
- [🛠️ Useful Procedures Included](#%EF%B8%8F-useful-procedures-included)
- [📦 All Imports](#-all-imports)
- [👨‍💻 About](#-about)

---

## 🔧 **How to Use**

Instantiate the `DenoKvFs` class:

```typescript
import { DenoKvFs } from "https://deno.land/x/deno_kv_fs/mod.ts";

const kvFs = new DenoKvFs();

// If you want to use your existing instance of Deno.Kv
const myDenoKV = await Deno.openKv(/* your parameters */);
const kvFs = new DenoKvFs(myDenoKV);
```

- Accepts any stream as input.
- Returns a generic stream of `type: "bytes"`.
- Incompletely saved files are automatically deleted.
- Read methods return the processing status of a file (useful for knowing
  progress).
- If a file does not exist, `null` is returned.

### **Save Method Interface**

The `save` method is used to save files:

```typescript
interface SaveOptions {
  path: string[]; // Mandatory. The root directory is []
  content: ReadableStream | Uint8Array | string; // Mandatory
  metadata?: Record<string, any>; // Optional. Store additional data with the file (max 60KB)
  chunksPerSecond?: number;
  clientId?: string | number;
  validateAccess?: (path: string[]) => Promise<boolean> | boolean;
  maxClientIdConcurrentReqs?: number;
  maxFileSizeBytes?: number;
  allowedExtensions?: string[];
}
```

### **Read, ReadDir, Delete, and DeleteDir Method Interface**

These methods are intended to read and delete files:

```typescript
interface ReadOptions {
  path: string[]; // Mandatory
  chunksPerSecond?: number;
  maxDirEntriesPerSecond?: number;
  clientId?: string | number;
  validateAccess?: (path: string[]) => Promise<boolean> | boolean;
  maxClientIdConcurrentReqs?: number;
  pagination?: boolean; // If true, returns the cursor to the next page (if exists).
  cursor?: string; // For readDir, if there is a next page.
}
```

---

## 💡 **Examples**

### 💾 **Saving Data**

```typescript
import { DenoKvFs } from "https://deno.land/x/deno_kv_fs/mod.ts";
import { toReadableStream } from "https://deno.land/std/io/mod.ts";

const kvFs = new DenoKvFs();
const fileName = "myFile.txt";

let resData = await kvFs.save({
  path: ["my_dir", fileName],
  content: toReadableStream(await Deno.open(fileName)),
});
```

---

### 💾 **Saving Data Directly**

> **Warning:** This is **not recommended** as it can fill up your RAM. Use only
> for internal resources of your application. For optimized use, prefer an
> instance of `ReadableStream`.

```typescript
const fileName = "myFile.txt";

let resData = await kvFs.save({
  path: ["my_dir", fileName],
  content: await Deno.readFile(fileName), // Or content: "myStringData"
});
```

---

### 📤 **Saving Data from a Submitted Form**

```typescript
const reqBody = await request.formData();
const existingFileNamesInTheUpload: { [key: string]: number } = {};
const res: any = {};

for (const item of reqBody.entries()) {
  if (item[1] instanceof File) {
    const formField: any = item[0];
    const fileData: any = item[1];

    if (!existingFileNamesInTheUpload[fileData.name]) {
      existingFileNamesInTheUpload[fileData.name] = 1;
    } else {
      existingFileNamesInTheUpload[fileData.name]++;
    }

    let prepend = "";
    if (existingFileNamesInTheUpload[fileData.name] > 1) {
      prepend += existingFileNamesInTheUpload[fileData.name].toString();
    }

    const fileName = prepend + fileData.name;
    let resData = await kvFs.save({
      path: ["my_dir", fileName],
      content: fileData.stream(),
    });

    if (res[formField] !== undefined) {
      if (Array.isArray(res[formField])) {
        res[formField].push(resData);
      } else {
        res[formField] = [res[formField], resData];
      }
    } else {
      res[formField] = resData;
    }
  }
}

console.log(res);
```

#### 🌐 **In Frontend**

```html
<form
  id="yourFormId"
  enctype="multipart/form-data"
  action="/upload"
  method="post"
>
  <input type="file" name="file1" multiple />
  <br />
  <input type="submit" value="Submit" />
</form>

<script>
  var files = document.querySelector("#yourFormId input[type=file]").files;
  var name = document
    .querySelector("#yourFormId input[type=file]")
    .getAttribute("name");
  var form = new FormData();

  for (var i = 0; i < files.length; i++) {
    form.append(`${name}_${i}`, files[i]);
  }

  var res = await fetch(`/your_POST_URL`, {
    // Fetch API automatically sets the form to "multipart/form-data"
    method: "POST",
    body: form,
  }).then((response) => response.json());

  console.log(res);
</script>
```

---

### 📥 **Returning Data**

```typescript
const fileName = "myFile.txt";

let resData = await kvFs.read({
  path: ["my_dir", fileName],
});

response.body = resData.content; // resData.content is an instance of ReadableStream
```

---

### 📥 **Returning Data Directly**

> **Warning:** This is **not recommended** as it can fill up your RAM. Use only
> for internal resources of your application. For optimized use, use the
> `ReadableStream` (`type: "bytes"`) that comes by default in `file.content`.

```typescript
const fileName = "myFile.txt";

let resData = await kvFs.read({
  path: ["my_dir", fileName],
});

response.body = await DenoKvFs.readStream(resData.content); // Or await DenoKvFs.readStreamAsString(resData.content)
```

---

### ⚙️ **Example Function to Control Data Traffic**

```typescript
const gigabyte = 1024 * 1024 * 1024;
const existingRequests = kvFs.getClientReqs(user.id); // The input parameter is the same as clientId
const chunksPerSecond = (user.isPremium() ? 20 : 1) / existingRequests;
const maxClientIdConcurrentReqs = user.isPremium() ? 5 : 1;
const maxFileSizeBytes = (user.isPremium() ? 1 : 0.1) * gigabyte;

// To read
let resData = await kvFs.read({
  path: ["my_dir", fileName],
  chunksPerSecond: chunksPerSecond,
  maxClientIdConcurrentReqs: maxClientIdConcurrentReqs,
  maxFileSizeBytes: maxFileSizeBytes,
  clientId: user.id, // The clientId can also be the remote address of a request
});

response.body = resData.content;

// To delete
let resData = await kvFs.delete({
  path: ["my_dir_2", fileName],
  chunksPerSecond: chunksPerSecond,
  maxClientIdConcurrentReqs: maxClientIdConcurrentReqs,
  maxFileSizeBytes: maxFileSizeBytes,
  clientId: user.id,
});

// Read directory
const maxDirEntriesPerSecond = user.isPremium() ? 1000 : 100;

let resData = await kvFs.readDir({
  path: ["my_dir"],
  chunksPerSecond: chunksPerSecond,
  maxClientIdConcurrentReqs: maxClientIdConcurrentReqs,
  maxFileSizeBytes: maxFileSizeBytes,
  clientId: user.id,
  maxDirEntriesPerSecond: maxDirEntriesPerSecond,
  pagination: true, // Each page has 1000 entries
  cursor: "JDhiasgPh", // If exists
});

// Delete directory
let resData = await kvFs.deleteDir({
  path: ["my_dir"],
  chunksPerSecond: chunksPerSecond,
  maxClientIdConcurrentReqs: maxClientIdConcurrentReqs,
  maxFileSizeBytes: maxFileSizeBytes,
  clientId: user.id,
  maxDirEntriesPerSecond: maxDirEntriesPerSecond,
});

// Controlling maximum user space
const maxAvailableSpace = (user.isPremium() ? 1 : 0.1) * gigabyte;

let dirList = await kvFs.readDir({
  path: [user.id, "files"], // Example
});

if (dirList.size > maxAvailableSpace) {
  throw new Error(
    `You have exceeded the ${maxAvailableSpace} GB limit of available space.`,
  );
}

// Validate access
let resData = await kvFs.readDir({
  path: ["my_dir"],
  validateAccess: async (path: string[]) =>
    user.hasDirAccess(path) ? true : false,
});
```

---

## 📡 **Sending File Progress in Real-Time**

To send file progress updates in real-time, you can use:

```typescript
kvFs.onFileProgress = (status: FileStatus) => {
  webSocket.send(JSON.stringify(status));
};
```

---

- **Get File Metadata:**

  ```typescript
  async getMetadata(path: string[]): Promise<Record<string, any> | undefined>;
  ```

- **Set File Metadata:**

  ```typescript
  async setMetadata(path: string[], metadata: Record<string, any>): Promise<void>;
  ```

### 📝 **Using File Metadata**

You can store additional data along with your files:

```typescript
// Saving a file with metadata
await kvFs.save({
  path: ["my_dir", "image.jpg"],
  content: imageStream,
  metadata: {
    author: "John Doe",
    createdAt: new Date().toISOString(),
    tags: ["vacation", "beach"],
    location: {
      lat: 25.7617,
      lng: -80.1918,
    },
  },
});

// Reading file metadata
const metadata = await kvFs.getMetadata(["my_dir", "image.jpg"]);
console.log(metadata.author); // "John Doe"

// Updating metadata
await kvFs.setMetadata(["my_dir", "image.jpg"], {
  ...metadata,
  lastModified: new Date().toISOString(),
});
```

> **Note:** Metadata is limited to 60KB when serialized as JSON to comply with
> Deno KV value size limits.

---

## 🛠️ **Useful Procedures Included**

- **Reading a Stream as Uint8Array:**

  ```typescript
  static async readStream(stream: ReadableStream): Promise<Uint8Array>;
  ```

- **Reading a Stream as String:**

  ```typescript
  static async readStreamAsString(stream: ReadableStream): Promise<string>;
  ```

- **Get Client Requests:**

  ```typescript
  getClientReqs(clientId: string | number): number;
  ```

- **Get All File Statuses:**

  ```typescript
  getAllFilesStatuses(): FileStatus[];
  ```

- **Convert Path to URI Component:**

  ```typescript
  pathToURIComponent(path: string[]): string;
  ```

- **Convert URI Component to Path:**

  ```typescript
  URIComponentToPath(path: string): string[];
  ```

- **Save a File:**

  ```typescript
  async save(options: SaveOptions): Promise<FileStatus | File>;
  ```

- **Read a File:**

  ```typescript
  async read(options: ReadOptions): Promise<File | FileStatus | null>;
  ```

- **Read a Directory:**

  ```typescript
  async readDir(options: ReadOptions): Promise<DirList>;
  ```

- **Delete a File:**

  ```typescript
  async delete(options: ReadOptions): Promise<void | FileStatus>;
  ```

- **Delete a Directory:**

  ```typescript
  async deleteDir(options: ReadOptions): Promise<FileStatus[]>;
  ```

---

## 📦 **All Imports**

```typescript
import {
  DenoKvFs,
  DirList,
  File,
  FileStatus,
  ReadOptions,
  SaveOptions,
} from "jsr:@hviana/deno-kv-fs";
```

---

## 👨‍💻 **About**

**Author:** Henrique Emanoel Viana, a Brazilian computer scientist and web
technology enthusiast.

- 📞 **Phone:** +55 (41) 99999-4664
- 🌐 **Website:**
  [https://sites.google.com/view/henriqueviana](https://sites.google.com/view/henriqueviana)

> **Improvements and suggestions are welcome!**

---
