//! Literal OpenSSH config import. It never executes Include/Match/commands.
//! Unknown routing is excluded rather than silently becoming a direct route.
use crate::{
    error::{AppError, Result},
    models::Host,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Serialize)]
pub struct ImportPreview {
    pub hosts: Vec<Host>,
    pub warnings: Vec<String>,
}

fn new_host(alias: &str) -> Host {
    Host {
        id: uuid::Uuid::new_v4().to_string(),
        name: alias.into(),
        address: alias.into(),
        port: 22,
        username: std::env::var("USER")
            .or_else(|_| std::env::var("USERNAME"))
            .unwrap_or_default(),
        group: "SSH config".into(),
        auth_method: "agent".into(),
        credential_store: "local".into(),
        private_key_path: None,
        proxy: None,
        jump_host_id: None,
        startup_directory: None,
        keep_alive_seconds: 30,
        connect_timeout_seconds: 15,
        favorite: false,
        color: "#63afff".into(),
        notes: String::new(),
    }
}

pub fn parse(text: &str) -> Result<ImportPreview> {
    if text.len() > 2 * 1024 * 1024 {
        return Err(AppError::new("CONFIG_TOO_LARGE", "SSH 配置不得超过 2 MiB"));
    }
    let mut hosts: Vec<Host> = Vec::new();
    let mut aliases: HashMap<String, usize> = HashMap::new();
    let mut assigned: Vec<HashSet<String>> = Vec::new();
    let mut warnings = Vec::new();
    let mut current = Vec::new();
    let mut jumps: Vec<(usize, String)> = Vec::new();
    let mut blocked = HashSet::new();
    let mut unknown_global_route = false;
    let mut scope_has_patterns = false;
    let mut assignments = 0usize;
    for (line_no, line) in text.lines().enumerate() {
        let fields = tokenize(line).map_err(|m| {
            AppError::new("SSH_CONFIG_PARSE", format!("第 {} 行：{m}", line_no + 1))
        })?;
        if fields.is_empty() {
            continue;
        }
        let key = fields[0].to_ascii_lowercase();
        let values = &fields[1..];
        if key == "host" {
            current.clear();
            scope_has_patterns = values.iter().any(|a| a.contains(['*', '?', '!']));
            if values.iter().any(|a| a.starts_with('!')) {
                warnings.push(format!(
                    "第 {} 行：包含否定模式的 Host 块未导入，请先展开为具体主机",
                    line_no + 1
                ));
                continue;
            }
            for alias in values {
                if alias.contains(['*', '?']) {
                    warnings.push(format!(
                        "第 {} 行：通配符 Host {alias} 未展开，请手动核对",
                        line_no + 1
                    ));
                    continue;
                }
                // Repeated literal blocks keep OpenSSH's first-value behavior.
                let index = if let Some(index) = aliases.get(alias) {
                    *index
                } else {
                    if hosts.len() >= 10000 {
                        return Err(AppError::new("TOO_MANY_HOSTS", "最多导入 10000 台主机"));
                    }
                    let index = hosts.len();
                    aliases.insert(alias.clone(), index);
                    hosts.push(new_host(alias));
                    assigned.push(HashSet::new());
                    index
                };
                if !current.contains(&index) {
                    current.push(index);
                }
            }
            continue;
        }
        if key == "match" {
            current.clear();
            scope_has_patterns = true;
            warnings.push(format!(
                "第 {} 行：Match 条件不执行，后续块跳过",
                line_no + 1
            ));
            continue;
        }
        if key == "include" {
            // An unread include could define an earlier ProxyCommand/ProxyJump.
            // Do not pretend that the visible text fully determines routing.
            unknown_global_route = true;
            warnings.push(format!(
                "第 {} 行：Include 未读取；请先提供展开后的配置再导入",
                line_no + 1
            ));
            continue;
        }
        if ["localcommand", "remotecommand", "permitlocalcommand"].contains(&key.as_str()) {
            warnings.push(format!("第 {} 行：{} 未导入或执行", line_no + 1, fields[0]));
            continue;
        }
        let Some(value) = values.first() else {
            continue;
        };
        let routing = key == "proxycommand" || key == "proxyjump";
        if routing && scope_has_patterns && value != "none" {
            unknown_global_route = true;
            warnings.push(format!(
                "第 {} 行：模式匹配的路由必须先展开，不能自动改为直连",
                line_no + 1
            ));
        }
        if current.is_empty() {
            if routing && value != "none" {
                unknown_global_route = true;
                warnings.push(format!(
                    "第 {} 行：无法确定全局/条件 {} 的路由范围，本次不自动导入主机",
                    line_no + 1,
                    fields[0]
                ));
            } else {
                warnings.push(format!(
                    "第 {} 行：全局或通配配置 {} 需手动核对",
                    line_no + 1,
                    fields[0]
                ));
            }
            continue;
        }
        assignments = assignments.saturating_add(current.len());
        if assignments > 250000 {
            return Err(AppError::new(
                "CONFIG_COMPLEXITY",
                "配置的主机与指令组合过多，请分批导入",
            ));
        }
        for &idx in &current {
            let slot = if routing {
                "network-route"
            } else {
                key.as_str()
            };
            if !assigned[idx].insert(slot.to_string()) {
                continue;
            }
            let h = &mut hosts[idx];
            match key.as_str() {
                "hostname" => h.address = value.clone(),
                "user" => h.username = value.clone(),
                "port" => {
                    h.port = value.parse().map_err(|_| {
                        AppError::new("SSH_CONFIG_PARSE", format!("第 {} 行端口无效", line_no + 1))
                    })?
                }
                "identityfile" => {
                    let p = if let Some(rest) = value.strip_prefix("~/") {
                        dirs::home_dir()
                            .map(|home| home.join(rest).to_string_lossy().to_string())
                            .unwrap_or(value.clone())
                    } else {
                        value.clone()
                    };
                    h.private_key_path = Some(p);
                    h.auth_method = "key".into();
                }
                "serveraliveinterval" => {
                    h.keep_alive_seconds = value.parse().map_err(|_| {
                        AppError::new(
                            "SSH_CONFIG_PARSE",
                            format!("第 {} 行心跳间隔无效", line_no + 1),
                        )
                    })?
                }
                "connecttimeout" => {
                    h.connect_timeout_seconds = value.parse().map_err(|_| {
                        AppError::new(
                            "SSH_CONFIG_PARSE",
                            format!("第 {} 行超时时间无效", line_no + 1),
                        )
                    })?
                }
                "proxyjump" => {
                    if value != "none" {
                        jumps.push((idx, value.clone()));
                    }
                }
                "proxycommand" => {
                    if value != "none" || values.len() != 1 {
                        blocked.insert(idx);
                        warnings.push(format!(
                            "{}：ProxyCommand 不执行；为防止错误直连，此主机未导入，请手动配置代理",
                            h.name
                        ));
                    }
                }
                "identitiesonly" => {
                    if value == "yes" && h.private_key_path.is_none() {
                        warnings.push(format!(
                            "{}：IdentitiesOnly=yes 但未找到 IdentityFile",
                            h.name
                        ));
                    }
                }
                _ => warnings.push(format!("{}：{} 尚未导入，请核对", h.name, fields[0])),
            }
        }
    }
    for (idx, alias) in jumps {
        if let Some(jump) = aliases.get(&alias) {
            hosts[idx].jump_host_id = Some(hosts[*jump].id.clone());
        } else {
            blocked.insert(idx);
            warnings.push(format!(
                "{}：跳板机 {alias} 不能安全解析，此主机未导入，请手动配置",
                hosts[idx].name
            ));
        }
    }
    let indices: HashMap<String, usize> = hosts
        .iter()
        .enumerate()
        .map(|(i, h)| (h.id.clone(), i))
        .collect();
    // Reject cycles and all hosts which depend on an excluded jump host.
    for index in 0..hosts.len() {
        let mut seen = HashSet::new();
        let mut cursor = Some(index);
        while let Some(current) = cursor {
            if !seen.insert(current) || seen.len() > 9 || blocked.contains(&current) {
                if blocked.insert(index) {
                    warnings.push(format!(
                        "{}：跳板链不可用、循环或过长，此主机未导入",
                        hosts[index].name
                    ));
                }
                break;
            }
            cursor = hosts[current]
                .jump_host_id
                .as_ref()
                .and_then(|id| indices.get(id).copied());
        }
    }
    for h in &hosts {
        if h.address.contains('%') || h.private_key_path.as_ref().is_some_and(|p| p.contains('%')) {
            warnings.push(format!("{}：包含 OpenSSH % 参数，请手动展开后保存", h.name));
        }
        if let Err(e) = crate::storage::validate_host(h) {
            warnings.push(format!("{}：{}", h.name, e.message));
        }
    }
    if unknown_global_route {
        hosts.clear();
        warnings.push(
            "存在未展开的全局路由或 Include；已保留原配置不变，请先展开这些指令后重新导入。".into(),
        );
    } else {
        hosts = hosts
            .into_iter()
            .enumerate()
            .filter_map(|(i, h)| (!blocked.contains(&i)).then_some(h))
            .collect();
    }
    Ok(ImportPreview { hosts, warnings })
}

fn tokenize(line: &str) -> std::result::Result<Vec<String>, String> {
    let mut result = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            // Preserve unquoted Windows path separators; escaped whitespace,
            // quotes and comment markers keep their literal meaning.
            if chars
                .peek()
                .is_some_and(|c| c.is_whitespace() || matches!(c, '\\' | '\'' | '"' | '#'))
            {
                word.push(chars.next().unwrap());
            } else {
                word.push(c);
            }
            continue;
        }
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else {
                word.push(c);
            }
            continue;
        }
        match c {
            '\'' | '"' => quote = Some(c),
            '#' => break,
            c if c.is_whitespace() => {
                if !word.is_empty() {
                    result.push(std::mem::take(&mut word));
                }
            }
            _ => word.push(c),
        }
    }
    if quote.is_some() {
        return Err("引号未闭合".into());
    }
    if !word.is_empty() {
        result.push(word);
    }
    if result.is_empty() {
        return Ok(result);
    }
    // ssh_config accepts Keyword value, Keyword=value and Keyword = value.
    if let Some(position) = result[0].find('=') {
        let rhs = result[0][position + 1..].to_string();
        result[0].truncate(position);
        if !rhs.is_empty() {
            result.insert(1, rhs);
        }
    } else if result.get(1).is_some_and(|s| s.starts_with('=')) {
        let rhs = result.remove(1)[1..].to_string();
        if !rhs.is_empty() {
            result.insert(1, rhs);
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn equals_separator_and_quoted_key_path_follow_literal_config() {
        let p = parse("Host jump\n HostName = example.net\n User=operator\nHost target\n HostName=10.0.0.1\n ProxyJump = jump\n IdentityFile = \"/home/user/a b\"\n").unwrap();
        assert_eq!(p.hosts.len(), 2);
        assert_eq!(p.hosts[0].address, "example.net");
        assert_eq!(p.hosts[0].username, "operator");
        assert_eq!(
            p.hosts[1].jump_host_id.as_deref(),
            Some(p.hosts[0].id.as_str())
        );
        assert_eq!(
            p.hosts[1].private_key_path.as_deref(),
            Some("/home/user/a b")
        );
    }
    #[test]
    fn unsupported_routes_and_their_dependents_never_become_direct_hosts() {
        let p = parse("Host jump\n ProxyCommand arbitrary-program\nHost target\n ProxyJump jump\nHost leaf\n ProxyJump target\nHost missing\n ProxyJump unknown\nHost direct\n HostName safe.example\n").unwrap();
        assert_eq!(p.hosts.len(), 1);
        assert_eq!(p.hosts[0].name, "direct");
        assert!(p.warnings.iter().any(|s| s.contains("ProxyCommand")));
        assert!(p.warnings.iter().any(|s| s.contains("leaf")));
    }
    #[test]
    fn unresolved_global_routes_and_includes_require_expansion() {
        assert!(
            parse("Host direct\n HostName example.com\nHost *\n ProxyCommand proxy\n")
                .unwrap()
                .hosts
                .is_empty()
        );
        assert!(
            parse("Host direct\n HostName example.com\nHost another *\n ProxyCommand proxy\n")
                .unwrap()
                .hosts
                .is_empty()
        );
        assert!(
            parse("Include common.conf\nHost direct\n HostName example.com\n")
                .unwrap()
                .hosts
                .is_empty()
        );
    }
    #[test]
    fn repeated_literal_blocks_preserve_first_value_and_proxy_precedence() {
        let p = parse("Host a\n HostName first.example\n ProxyJump none\nHost a\n HostName second.example\n ProxyCommand must-not-run\n").unwrap();
        assert_eq!(p.hosts.len(), 1);
        assert_eq!(p.hosts[0].address, "first.example");
        assert!(p.hosts[0].jump_host_id.is_none());
    }
    #[test]
    fn cycles_and_windows_path_separators_are_handled() {
        assert!(parse("Host a\n ProxyJump b\nHost b\n ProxyJump a\n")
            .unwrap()
            .hosts
            .is_empty());
        let p = parse("Host a\n IdentityFile C:\\Users\\jojo\\.ssh\\id_ed25519\n").unwrap();
        assert_eq!(
            p.hosts[0].private_key_path.as_deref(),
            Some(r"C:\Users\jojo\.ssh\id_ed25519")
        );
    }
}
