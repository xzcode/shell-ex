import { expect, test } from "@playwright/test";
import { filterMounts, sortProcesses, appendDiskHistory } from "../src/monitorModel";
import type { DiskMount, DiskIo, ProcessInfo } from "../src/types";

const mounts: DiskMount[] = [
  { path: "/", source: "/dev/vda1", fsType: "xfs", category: "local", deviceId: "252:1", duplicate: false, total: 10000, used: 3000, available: 7000 },
  { path: "/bind", source: "/dev/vda1", fsType: "xfs", category: "local", deviceId: "252:1", duplicate: true, total: 10000, used: 3000, available: 7000 },
  { path: "/container", source: "overlay", fsType: "overlay", category: "virtual", duplicate: false, total: 10000, used: 3000, available: 7000 },
  { path: "/run", source: "tmpfs", fsType: "tmpfs", category: "virtual", duplicate: false, total: 2000, used: 20, available: 1980 },
  { path: "/nas", source: "nas:/data", fsType: "nfs4", category: "network", duplicate: false, total: 50000, used: 10000, available: 40000 },
];
const processes: ProcessInfo[] = [
  { pid: 42, user: "root", cpu: 20, memory: 0.5, rssBytes: 10*1024*1024, command: "cpu-heavy" },
  { pid: 43, user: "postgres", cpu: 1, memory: 40, rssBytes: 800*1024*1024, command: "memory-heavy" },
  { pid: 44, user: "test", cpu: null, memory: 0, rssBytes: 0, command: "new-process" },
];
const device: DiskIo = {
  name: "vda", deviceId: "252:0", layer: "device",
  readBytesPerSec: 10240, writeBytesPerSec: 20480, readIops: 4, writeIops: 8,
  utilization: 25, awaitMs: 2, readAwaitMs: 1, writeAwaitMs: 2.5, queueDepth: 0.4,
};

test("monitor filters, process sorting, and per-device histories use raw telemetry", () => {
  expect(filterMounts(mounts, "storage").map((m) => m.path)).toEqual(["/", "/nas"]);
  expect(filterMounts(mounts, "local").map((m) => m.path)).toEqual(["/"]);
  expect(filterMounts(mounts, "network").map((m) => m.path)).toEqual(["/nas"]);
  expect(filterMounts(mounts, "all")).toHaveLength(5);
  expect(sortProcesses(processes, { key: "cpu", direction: "desc" }).map((p) => p.pid)).toEqual([42,43,44]);
  expect(sortProcesses(processes, { key: "cpu", direction: "asc" }).map((p) => p.pid)).toEqual([43,42,44]);
  expect(sortProcesses(processes, { key: "memory", direction: "desc" }).map((p) => p.pid)).toEqual([43,42,44]);
  expect(sortProcesses(processes, { key: "memory", direction: "desc" }, "postgres").map((p) => p.pid)).toEqual([43]);
  const first = appendDiskHistory({}, [device], 1000);
  expect(first["252:0/vda"]).toEqual([{at:1000, read:10240, write:20480, busy:25}]);
  expect(appendDiskHistory(first, [{...device, utilization:null}], 2000)["252:0/vda"]).toEqual([]);
  expect(appendDiskHistory(first, [], 3000)).toEqual({});
});

test("detached monitor displays storage types, per-device I/O, CPU/RSS sorts and full process search", async ({ page }) => {
  await page.addInitScript(({mounts, processes, device}) => {
    let count=0;
    Object.defineProperty(window, "isTauri", {value:true});
    Object.defineProperty(window, "__TAURI_INTERNALS__", {value:{
      metadata:{currentWindow:{label:"monitor"},currentWebview:{label:"monitor",windowLabel:"monitor"}},
      transformCallback:()=>1,
      invoke:async(cmd:string)=>{
        if(cmd==="monitor_window_context") return {session:{id:"fixture",name:"Storage fixture"},theme:"black",monitorInterval:3,language:"zh-CN"};
        if(cmd==="monitor_window_snapshot") {
          count++;
          return {
            hostname:"Storage fixture",os:"Linux",kernel:"6.1",cpuCores:4,uptime:120+count,load:[0,0,0],cpuPercent:20,
            memoryTotal:2*1024*1024*1024,memoryUsed:500*1024*1024,swapTotal:0,swapUsed:0,
            diskTotal:10000,diskUsed:3000,diskMounts:mounts,storagePartial:false,
            diskIo:[
              count===1?{...device,readBytesPerSec:null,writeBytesPerSec:null,utilization:null,readIops:null,writeIops:null,awaitMs:null,readAwaitMs:null,writeAwaitMs:null,queueDepth:null}:device,
              {...device,name:"dm-0",deviceId:"253:0",layer:"logical",readBytesPerSec:1024,writeBytesPerSec:0,utilization:2},
            ],
            networkRx:count*4096,networkTx:count*2048,networkInterfaces:[],
            processCount:123,processTruncated:false,
            processes:[...processes,...Array.from({length:120},(_,i)=>({pid:1000+i,user:"other",cpu:0,memory:0,rssBytes:1024,command:"worker-"+i}))],
          };
        }
        throw Error("Unexpected command "+cmd);
      }
    }});
  },{mounts,processes,device});
  await page.setViewportSize({width:760,height:900});
  await page.goto("/");
  const panel=page.locator(".detached-monitor-window .monitor-panel");
  const storage=panel.locator(".storage-monitor");
  const rows=storage.locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(storage).toContainText("/dev/vda1");
  await expect(storage).toContainText("nfs4");
  await expect(storage).not.toContainText("overlay");
  await storage.getByRole("combobox",{name:"存储类型"}).selectOption("local");
  await expect(rows).toHaveCount(1);
  await storage.getByRole("combobox",{name:"存储类型"}).selectOption("network");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("/nas");
  await storage.getByRole("combobox",{name:"存储类型"}).selectOption("all");
  await expect(rows).toHaveCount(5);
  await expect(storage).toContainText("overlay");
  await expect(storage).toContainText("重复挂载");
  const io=panel.locator(".disk-io-monitor");
  await panel.getByRole("button",{name:"立即刷新",exact:true}).click();
  await expect(io.locator('[data-io-value="read"]')).toHaveText("10 KB/s");
  await expect(io.locator('[data-io-value="util"]')).toHaveText("25.0%");
  await expect(io.locator('[data-chart="disk-util"] .monitor-chart-y > span')).toHaveText(["100%","75%","50%","25%","0%"]);
  await io.getByRole("combobox",{name:"磁盘设备"}).selectOption("253:0/dm-0");
  await expect(io.locator('[data-io-value="read"]')).toHaveText("1 KB/s");
  const mini=panel.locator('[data-monitor-table="mini-process"]');
  await expect(mini.locator("tbody tr").first()).toContainText("cpu-heavy");
  await panel.getByRole("button",{name:"内存排序",exact:true}).click();
  await expect(mini.locator("tbody tr").first()).toContainText("memory-heavy");
  await expect(mini.locator("tbody tr").first()).toContainText("800.0 MB");
  await panel.getByRole("button",{name:"全部进程",exact:true}).click();
  const dialog=page.getByRole("dialog");
  const table=dialog.locator('[data-monitor-table="processes-readonly"]');
  await expect(table.locator("tbody tr")).toHaveCount(100);
  await expect(table.locator("tbody tr").first()).toContainText("memory-heavy");
  await dialog.getByRole("button",{name:"按 CPU 排序",exact:true}).click();
  await expect(table.locator("tbody tr").first()).toContainText("cpu-heavy");
  await dialog.getByRole("button",{name:"下一页",exact:true}).click();
  await expect(table.locator("tbody tr")).toHaveCount(23);
  await dialog.getByRole("textbox",{name:"搜索进程"}).fill("memory-heavy");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.locator("tbody tr").first()).toContainText("memory-heavy");
  await expect(dialog.getByRole("button",{name:"终止",exact:true})).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
