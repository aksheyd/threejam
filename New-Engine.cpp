#include "./Bin/Include/glad/glad.h"
#include "./Bin/Include/GLFW/glfw3.h"
#include "./Bin/Include/glm/glm.hpp"
#include "./Bin/Include/glm/gtc/matrix_transform.hpp"
#include "./Bin/Include/glm/gtc/type_ptr.hpp"
#include "./Bin/Include/stb/stb_image.h"
#include <iostream>

const unsigned int SCR_WIDTH = 800;
const unsigned int SCR_HEIGHT = 600;

#include "shader_s.h"

#include "Object.h"
#include "Component.h"

#include "GameObject.h"

#include "Camera.h"
#include "Renderer.h"
#include "MeshRenderer.h"
#include "MeshFilter.h"
#include "Transform.h"

#include "Triangle.h"
#include "Square.h"

#include "Input.h"

#include <thread>

void SetWireframe() {
	glPolygonMode(GL_FRONT_AND_BACK, GL_LINE);
}
void framebuffer_size_callback(GLFWwindow* window, int width, int height);
//void mouse_callback(GLFWwindow* window, double xpos, double ypos);
//void scroll_callback(GLFWwindow* window, double xoffset, double yoffset);
void processInput(GLFWwindow* window);

// Set static variables
int Object::_idCounter = 0;
Camera* Camera::main = nullptr;

class Script : public Component {
public:
	Script() : Component("UserScript") { }

	void Update() {
		Input::WASD(transform, 0.01f, window);
	}
};

int main()
{
	glfwInit();
	glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
	glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 3);
	glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);

#ifdef __APPLE__
	glfwWindowHint(GLFW_OPENGL_FORWARD_COMPAT, GL_TRUE);
#endif

	GLFWwindow* window = glfwCreateWindow(SCR_WIDTH, SCR_HEIGHT, "LearnOpenGL", NULL, NULL);
	if (window == NULL)
	{
		std::cout << "Failed to create GLFW window" << std::endl;
		glfwTerminate();
		return -1;
	}
	glfwMakeContextCurrent(window);
	glfwSetFramebufferSizeCallback(window, framebuffer_size_callback);

	if (!gladLoadGLLoader((GLADloadproc)glfwGetProcAddress))
	{
		std::cout << "Failed to initialize GLAD" << std::endl;
		return -1;
	}


	// Camera gameobject with editable transform
	GameObject cam(window);
	cam.AddComponent<Camera>();
	Camera* camComp = cam.GetComponent<Camera>(); 
	cam.transform->position = glm::vec3(0.0f, 0.0f, 3.0f);
	

	// *- Users should not be able to add Camera -*
	// square with transform thanks to camera
	GameObject mySquare(window);
	mySquare.AddComponent<MeshRenderer>();
	mySquare.AddComponent<MeshFilter>();
	mySquare.GetComponent<MeshRenderer>()->color = glm::vec4(0.0f, 1.0f, 0.0f, 0.5f);
	mySquare.GetComponent<MeshFilter>()->mesh = new Square();
	mySquare.transform->position = glm::vec3(0.5f, 0.5f, 0.0f);
	mySquare.AddComponent<Script>();

	// square with transform thanks to camera
	GameObject mySquare2(window);
	mySquare2.AddComponent<MeshRenderer>();
	mySquare2.AddComponent<MeshFilter>();
	mySquare2.GetComponent<MeshFilter>()->mesh = new Square();
	mySquare2.transform->position = glm::vec3(-0.5f, -0.5f, 0.0f);

	if (!gladLoadGLLoader((GLADloadproc)glfwGetProcAddress))
	{
		std::cout << "Failed to initialize GLAD" << std::endl;
		return -1;
	}

	glEnable(GL_DEPTH_TEST);
	while (!glfwWindowShouldClose(window))
	{
		processInput(window); // esc to exit

		glClearColor(0.2f, 0.3f, 0.3f, 1.0f);
		glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);

		// error check if no main camera set
		if (Camera::main == nullptr) {
			std::cout << "ERROR::NO::CAMERA::SET" << std::endl;
			return 1;
		}
		
		cam.Update();
		mySquare.Update();
		mySquare2.Update();

		glfwSwapBuffers(window);
		glfwPollEvents();
	}

	glfwTerminate();

	return 0;
}

// https://vkguide.dev/docs/extra-chapter/multithreading/


//// process all input: query GLFW whether relevant keys are pressed/released this frame and react accordingly
//// ---------------------------------------------------------------------------------------------------------
void processInput(GLFWwindow* window)
{
	if (glfwGetKey(window, GLFW_KEY_ESCAPE) == GLFW_PRESS)
		glfwSetWindowShouldClose(window, true);

	//if (glfwGetKey(window, GLFW_KEY_W) == GLFW_PRESS)
	//	camera.ProcessKeyboard(FORWARD, deltaTime);
	//if (glfwGetKey(window, GLFW_KEY_S) == GLFW_PRESS)
	//	camera.ProcessKeyboard(BACKWARD, deltaTime);
	//if (glfwGetKey(window, GLFW_KEY_A) == GLFW_PRESS)
	//	camera.ProcessKeyboard(LEFT, deltaTime);
	//if (glfwGetKey(window, GLFW_KEY_D) == GLFW_PRESS)
	//	camera.ProcessKeyboard(RIGHT, deltaTime);
}

// glfw: whenever the window size changed (by OS or user resize) this callback function executes
// ---------------------------------------------------------------------------------------------
void framebuffer_size_callback(GLFWwindow* window, int width, int height)
{
	// make sure the viewport matches the new window dimensions; note that width and 
	// height will be significantly larger than specified on retina displays.
	glViewport(0, 0, width, height);
}
//
//
//// glfw: whenever the mouse moves, this callback is called
//// -------------------------------------------------------
//void mouse_callback(GLFWwindow* window, double xposIn, double yposIn)
//{
//	float xpos = static_cast<float>(xposIn);
//	float ypos = static_cast<float>(yposIn);
//
//	if (firstMouse)
//	{
//		lastX = xpos;
//		lastY = ypos;
//		firstMouse = false;
//	}
//
//	float xoffset = xpos - lastX;
//	float yoffset = lastY - ypos; // reversed since y-coordinates go from bottom to top
//
//	lastX = xpos;
//	lastY = ypos;
//
//	camera.ProcessMouseMovement(xoffset, yoffset);
//}
//
//// glfw: whenever the mouse scroll wheel scrolls, this callback is called
//// ----------------------------------------------------------------------
//void scroll_callback(GLFWwindow* window, double xoffset, double yoffset)
//{
//	camera.ProcessMouseScroll(static_cast<float>(yoffset));
//}