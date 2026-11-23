use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub code: String,
    pub message: String,
}
pub type Result<T> = std::result::Result<T, AppError>;
impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
    pub fn io(error: impl std::fmt::Display) -> Self {
        Self::new("IO_ERROR", error.to_string())
    }
    pub fn internal(error: impl std::fmt::Display) -> Self {
        Self::new("INTERNAL", error.to_string())
    }
}
impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for AppError {}
impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::io(e)
    }
}
impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        Self::internal(e)
    }
}
impl From<russh::Error> for AppError {
    fn from(e: russh::Error) -> Self {
        Self::new("SSH_ERROR", e.to_string())
    }
}
impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        Self::new("INVALID_DATA", e.to_string())
    }
}
impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        Self::new("DATABASE_ERROR", e.to_string())
    }
}
